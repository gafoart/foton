import * as THREE from "three";
import type { SplatMesh } from "@sparkjsdev/spark";
import { dyno } from "@sparkjsdev/spark";
import {
  COLOR_GRADE_GLSL,
  IDENTITY_GRADE,
  gradeToVectors,
  type PackedGrade,
} from "./colorGrade.js";

/**
 * Pseudo-clearcoat with HDRI environment reflections, applied to exterior
 * SplatMeshes via a Spark `worldModifier`. Pseudo-normal is derived from
 * (splat.center - maskCenter) for a smooth body shape instead of per-Gaussian
 * quaternion noise.
 *
 * The reflection vector R = reflect(-V, N) is converted to equirectangular UV
 * and used to sample an HDRI texture. Fresnel, sphere mask, and bottom-plane
 * mask modulate the contribution exactly as the old directional highlight did.
 */

type ClearcoatBlock = ReturnType<typeof buildModifier>;

interface AppliedEntry {
  key: string;
  mesh: SplatMesh;
  group: THREE.Group;
}

declare global {
  // eslint-disable-next-line no-var
  var __clearcoat: ClearcoatConsoleApi | undefined;
}

interface ClearcoatConsoleApi {
  setStrength(v: number): void;
  setPower(v: number): void;
  setEnvIntensity(v: number): void;
  setTint(r: number, g: number, b: number): void;
  setMaskRadius(v: number): void;
  setMaskRadiusScale(s: number): void;
  setMaskCenter(x: number, y: number, z: number): void;
  setMaskBottomY(v: number): void;
  setBottomFraction(f: number): void;
  setMaskBottomFeather(v: number): void;
  setWrap(w: number): void;
  enable(on?: boolean): void;
  status(): void;
}

type DynoVec3Uniform = ReturnType<typeof dyno.dynoVec3<THREE.Vector3>>;
type DynoVec4Uniform = ReturnType<typeof dyno.dynoVec4<THREE.Vector4>>;
type DynoFloatUniform = ReturnType<typeof dyno.dynoFloat>;
type DynoIntUniform = ReturnType<typeof dyno.dynoInt>;
type DynoSampler2DUniform = ReturnType<typeof dyno.dynoSampler2D<THREE.Texture>>;

interface ClearcoatUniforms {
  uViewPos: DynoVec3Uniform;
  uEnvMap: DynoSampler2DUniform;
  uEnvIntensity: DynoFloatUniform;
  uCoatStrength: DynoFloatUniform;
  uCoatPower: DynoFloatUniform;
  uCoatTint: DynoVec3Uniform;
  uMaskCenter: DynoVec3Uniform;
  uMaskRadius: DynoFloatUniform;
  uMaskBottomY: DynoFloatUniform;
  uMaskBottomFeather: DynoFloatUniform;
  uSelectionTex: DynoSampler2DUniform;
  uSelectionWidth: DynoIntUniform;
  uBaseRefl: DynoFloatUniform;
  uDebugTint: DynoFloatUniform;
  /** Lower edge of the back-facing smoothstep (N·V). Raising `wrap` pushes both
   * edges negative so the effect reaches around to back-facing (tail) splats. */
  uFacingEdge0: DynoFloatUniform;
  uFacingEdge1: DynoFloatUniform;
  // --- Photoshock color grade (applied to masked paint splats before clearcoat) ---
  /** 1 = apply the color grade, 0 = pass paint through unchanged (white base). */
  uGradeMix: DynoFloatUniform;
  uGradeBasicA: DynoVec4Uniform; // exposure(EV), contrast, blackPoint, whitePoint
  uGradeBasicB: DynoVec4Uniform; // saturation, temperature, tint, _
  uGradeWheelSh: DynoVec3Uniform;
  uGradeWheelMd: DynoVec3Uniform;
  uGradeWheelHi: DynoVec3Uniform;
  uGradeCross: DynoVec4Uniform;
  uGradeSec0: DynoVec3Uniform;
  uGradeSec1: DynoVec3Uniform;
  uGradeSec2: DynoVec3Uniform;
  uGradeSec3: DynoVec3Uniform;
  uGradeSec4: DynoVec3Uniform;
  uGradeSec5: DynoVec3Uniform;
  uGradeSec6: DynoVec3Uniform;
  uGradeSec7: DynoVec3Uniform;
  uGradeToneMode: DynoIntUniform;
}

function buildModifier({
  uViewPos,
  uEnvMap,
  uEnvIntensity,
  uCoatStrength,
  uCoatPower,
  uCoatTint,
  uMaskCenter,
  uMaskRadius,
  uMaskBottomY,
  uMaskBottomFeather,
  uSelectionTex,
  uSelectionWidth,
  uBaseRefl,
  uDebugTint,
  uFacingEdge0,
  uFacingEdge1,
  uGradeMix,
  uGradeBasicA,
  uGradeBasicB,
  uGradeWheelSh,
  uGradeWheelMd,
  uGradeWheelHi,
  uGradeCross,
  uGradeSec0,
  uGradeSec1,
  uGradeSec2,
  uGradeSec3,
  uGradeSec4,
  uGradeSec5,
  uGradeSec6,
  uGradeSec7,
  uGradeToneMode,
}: ClearcoatUniforms) {
  const f0 = dyno.dynoConst("float", 0);
  const f1 = dyno.dynoConst("float", 1);
  const half = dyno.dynoConst("float", 0.5);
  const negOne = dyno.dynoConst("float", -1);
  const eps = dyno.dynoConst("float", 1e-7);
  const negEps = dyno.dynoConst("float", -1e-7);
  const piConst = dyno.dynoConst("float", Math.PI);
  const invTwoPi = dyno.dynoConst("float", 1.0 / (2.0 * Math.PI));
  const invPi = dyno.dynoConst("float", 1.0 / Math.PI);

  return dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {
      if (!gsplat) throw new Error("clearcoat: gsplat missing");
      const parts = dyno.splitGsplat(gsplat).outputs;
      const center = parts.center;
      const rgb = parts.rgb;

      // Pseudo-normal from body-relative position.
      const toCenter = dyno.sub(center, uMaskCenter);
      const N = dyno.normalize(toCenter);

      // View vector from splat to camera.
      const V = dyno.normalize(dyno.sub(uViewPos, center));

      const rawNdotV = dyno.dot(N, V);
      const NdotV = dyno.clamp(rawNdotV, f0, f1);

      // Back-facing suppression (edges driven by `wrap` — see setWrap).
      const facing = dyno.smoothstep(uFacingEdge0, uFacingEdge1, rawNdotV);

      // Fresnel + base reflection floor.
      const fresnel = dyno.pow(dyno.sub(f1, NdotV), uCoatPower);
      const reflAmount = dyno.mix(uBaseRefl, f1, fresnel);

      // Reflection vector: R = reflect(-V, N).
      const negV = dyno.neg(V);
      const R = dyno.reflectVec(negV, N);

      // Equirectangular UV from reflection vector.
      // Manual atan2(z, x): dyno.atan2 emits invalid GLSL 'atan2'; WebGL only
      // has 'atan(y,x)'. We use single-arg atan(z/x) + quadrant correction.
      const Rparts = dyno.split(R).outputs;
      const safeRx = dyno.add(Rparts.x, eps);
      const baseAngle = dyno.atan(dyno.div(Rparts.z, safeRx));
      const xIsNeg = dyno.step(Rparts.x, negEps);
      const rSign = dyno.sign(Rparts.z);
      const correction = dyno.mul(dyno.mul(xIsNeg, rSign), piConst);
      const angle = dyno.add(baseAngle, correction);
      const u = dyno.add(dyno.mul(angle, invTwoPi), half);
      const v = dyno.add(
        dyno.mul(dyno.asin(dyno.clamp(Rparts.y, negOne, f1)), invPi),
        half
      );
      const uv = dyno.combine({ vectorType: "vec2" as const, x: u, y: v });

      // Sample HDRI env map.
      const envSample = dyno.texture(uEnvMap, uv);
      const envParts = dyno.split(envSample).outputs;
      const envRgb = dyno.combine({
        vectorType: "vec3" as const,
        x: envParts.r,
        y: envParts.g,
        z: envParts.b,
      });
      const envColor = dyno.mul(envRgb, uEnvIntensity);

      const intensity = dyno.mul(reflAmount, facing);

      // Per-splat selection mask via texelFetch.
      const splatIndex = parts.index;
      const ix = dyno.imod(splatIndex, uSelectionWidth);
      const iy = dyno.div(splatIndex, uSelectionWidth);
      const texCoord = dyno.combine({ vectorType: "ivec2" as const, x: ix, y: iy });
      const lod0 = dyno.dynoConst("int", 0);
      const maskSample = dyno.texelFetch(uSelectionTex, texCoord, lod0);
      const selectionMask = dyno.split(maskSample).outputs.r;

      const mask = selectionMask;

      // --- Color grade (Photoshock) on masked paint splats, BEFORE clearcoat ---
      // Recolours the white base body to the target color. Runs the full ported
      // pipeline via raw GLSL (cg_color_grade); gated by mask * uGradeMix so the
      // white preset / unmasked splats pass through untouched.
      const lum = dyno.clamp(
        dyno.dot(rgb, dyno.dynoConst("vec3", new THREE.Vector3(0.2126, 0.7152, 0.0722))),
        f0,
        f1
      );
      const gradedRgb = dyno.dyno({
        inTypes: {
          col: "vec3", L: "float", A: "vec4", B: "vec4",
          wSh: "vec3", wMd: "vec3", wHi: "vec3", cr: "vec4",
          s0: "vec3", s1: "vec3", s2: "vec3", s3: "vec3",
          s4: "vec3", s5: "vec3", s6: "vec3", s7: "vec3", tm: "int",
        },
        outTypes: { outRgb: "vec3" },
        inputs: {
          col: rgb, L: lum, A: uGradeBasicA, B: uGradeBasicB,
          wSh: uGradeWheelSh, wMd: uGradeWheelMd, wHi: uGradeWheelHi, cr: uGradeCross,
          s0: uGradeSec0, s1: uGradeSec1, s2: uGradeSec2, s3: uGradeSec3,
          s4: uGradeSec4, s5: uGradeSec5, s6: uGradeSec6, s7: uGradeSec7,
          tm: uGradeToneMode,
        },
        globals: () => [COLOR_GRADE_GLSL],
        statements: ({ inputs, outputs }) => [
          `${outputs.outRgb} = cg_color_grade(${inputs.col}, ${inputs.L}, ${inputs.A}, ${inputs.B}, ${inputs.wSh}, ${inputs.wMd}, ${inputs.wHi}, ${inputs.cr}, ${inputs.s0}, ${inputs.s1}, ${inputs.s2}, ${inputs.s3}, ${inputs.s4}, ${inputs.s5}, ${inputs.s6}, ${inputs.s7}, ${inputs.tm});`,
        ],
      }).outputs.outRgb;
      const gradeApply = dyno.mul(mask, uGradeMix);
      const baseRgb = dyno.mix(rgb, gradedRgb, gradeApply);

      const k = dyno.mul(dyno.mul(intensity, uCoatStrength), mask);
      const addRgb = dyno.mul(dyno.mul(envColor, uCoatTint), k);

      // Debug mode: flat red tint on masked splats (bypasses fresnel/env)
      const debugK = dyno.mul(uCoatStrength, mask);
      const debugRgb = dyno.combine({ vectorType: "vec3" as const, x: debugK, y: f0, z: f0 });
      const finalAdd = dyno.mix(addRgb, debugRgb, uDebugTint);
      const newRgb = dyno.add(baseRgb, finalAdd);

      return {
        gsplat: dyno.combineGsplat({ gsplat, rgb: newRgb }),
      };
    },
    { globals: () => [dyno.defineGsplat] }
  );
}

/**
 * 1x1 black texture for the selection mask default — "no mask = no FX". Keeps a
 * model with no `{model}_mask.json` (or before its mask loads) from getting the
 * grade/clearcoat applied to the whole body, and avoids leaking the previous
 * model's mask across a model switch.
 */
function makeEmptyMaskTexture(): THREE.DataTexture {
  const data = new Uint8Array([0, 0, 0, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

/**
 * 1x1 white texture — the DEFAULT clearcoat environment when no HDRI is set.
 * Gives a flat neutral reflection so the clearcoat still shows its default look
 * (modulated by strength/power/envIntens/mask); replaced by a real HDRI when one
 * is configured. (A black env would zero the reflection → no clearcoat at all.)
 */
function makeDefaultEnvTexture(): THREE.DataTexture {
  const data = new Uint8Array([255, 255, 255, 255]);
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

export interface CarClearcoatOptions {
  strength?: number;
  power?: number;
  envIntensity?: number;
  tint?: [number, number, number];
}

export class CarClearcoatController {
  private uViewPos: DynoVec3Uniform;
  private uEnvMap: DynoSampler2DUniform;
  private uEnvIntensity: DynoFloatUniform;
  private uCoatStrength: DynoFloatUniform;
  private uCoatPower: DynoFloatUniform;
  private uCoatTint: DynoVec3Uniform;
  private uMaskCenter: DynoVec3Uniform;
  private uMaskRadius: DynoFloatUniform;
  private uMaskBottomY: DynoFloatUniform;
  private uMaskBottomFeather: DynoFloatUniform;
  private uSelectionTex: DynoSampler2DUniform;
  private uSelectionWidth: DynoIntUniform;
  private uBaseRefl: DynoFloatUniform;
  private uDebugTint: DynoFloatUniform;
  private uFacingEdge0: DynoFloatUniform;
  private uFacingEdge1: DynoFloatUniform;
  private uGradeMix: DynoFloatUniform;
  private uGradeBasicA: DynoVec4Uniform;
  private uGradeBasicB: DynoVec4Uniform;
  private uGradeWheelSh: DynoVec3Uniform;
  private uGradeWheelMd: DynoVec3Uniform;
  private uGradeWheelHi: DynoVec3Uniform;
  private uGradeCross: DynoVec4Uniform;
  private uGradeSec: DynoVec3Uniform[];
  private uGradeToneMode: DynoIntUniform;
  private bottomFraction: number;
  private bottomFeather: number;
  /** Multiplier on the auto-computed sphere-mask radius (survives model swaps). */
  private maskRadiusScale = 1.0;
  private modifier: ClearcoatBlock;
  private applied: AppliedEntry[] = [];
  private enabled = true;

  constructor(opts: CarClearcoatOptions = {}) {
    const tint = opts.tint ?? [1.0, 1.0, 1.05];

    this.uViewPos = dyno.dynoVec3(new THREE.Vector3(), "carClearcoat_viewPos");
    this.uEnvMap = dyno.dynoSampler2D(
      makeDefaultEnvTexture(),
      "carClearcoat_envMap"
    );
    this.uEnvIntensity = dyno.dynoFloat(opts.envIntensity ?? 1.0, "carClearcoat_envIntensity");
    this.uCoatStrength = dyno.dynoFloat(opts.strength ?? 0.12, "carClearcoat_strength");
    this.uCoatPower = dyno.dynoFloat(opts.power ?? 1.0, "carClearcoat_power");
    this.uCoatTint = dyno.dynoVec3(
      new THREE.Vector3(tint[0], tint[1], tint[2]),
      "carClearcoat_tint"
    );
    this.uMaskCenter = dyno.dynoVec3(new THREE.Vector3(0, 0, 0), "carClearcoat_maskCenter");
    this.uMaskRadius = dyno.dynoFloat(0.0001, "carClearcoat_maskRadius");
    this.bottomFraction = 0.35;
    this.bottomFeather = 0.12;
    this.uMaskBottomY = dyno.dynoFloat(-1e6, "carClearcoat_maskBottomY");
    this.uMaskBottomFeather = dyno.dynoFloat(this.bottomFeather, "carClearcoat_maskBottomFeather");
    this.uSelectionTex = dyno.dynoSampler2D(
      makeEmptyMaskTexture(),
      "carClearcoat_selTex"
    );
    this.uSelectionWidth = dyno.dynoInt(1, "carClearcoat_selWidth");
    this.uBaseRefl = dyno.dynoFloat(0, "carClearcoat_baseRefl");
    this.uDebugTint = dyno.dynoFloat(0, "carClearcoat_debugTint");
    // wrap=0 defaults: matches the original (0.05, 0.35) back-face smoothstep.
    this.uFacingEdge0 = dyno.dynoFloat(0.05, "carClearcoat_facingEdge0");
    this.uFacingEdge1 = dyno.dynoFloat(0.35, "carClearcoat_facingEdge1");

    // Color grade — starts at identity (no recolor) until a preset is set.
    const ig = gradeToVectors(IDENTITY_GRADE);
    this.uGradeMix = dyno.dynoFloat(0, "carClearcoat_gradeMix");
    this.uGradeBasicA = dyno.dynoVec4(ig.basicA, "carClearcoat_gradeBasicA");
    this.uGradeBasicB = dyno.dynoVec4(ig.basicB, "carClearcoat_gradeBasicB");
    this.uGradeWheelSh = dyno.dynoVec3(ig.wheelSh, "carClearcoat_gradeWheelSh");
    this.uGradeWheelMd = dyno.dynoVec3(ig.wheelMd, "carClearcoat_gradeWheelMd");
    this.uGradeWheelHi = dyno.dynoVec3(ig.wheelHi, "carClearcoat_gradeWheelHi");
    this.uGradeCross = dyno.dynoVec4(ig.cross, "carClearcoat_gradeCross");
    this.uGradeSec = ig.sectors.map((s, i) =>
      dyno.dynoVec3(s, `carClearcoat_gradeSec${i}`)
    );
    this.uGradeToneMode = dyno.dynoInt(ig.toneMode, "carClearcoat_gradeToneMode");

    this.modifier = buildModifier({
      uViewPos: this.uViewPos,
      uEnvMap: this.uEnvMap,
      uEnvIntensity: this.uEnvIntensity,
      uCoatStrength: this.uCoatStrength,
      uCoatPower: this.uCoatPower,
      uCoatTint: this.uCoatTint,
      uMaskCenter: this.uMaskCenter,
      uMaskRadius: this.uMaskRadius,
      uMaskBottomY: this.uMaskBottomY,
      uMaskBottomFeather: this.uMaskBottomFeather,
      uSelectionTex: this.uSelectionTex,
      uSelectionWidth: this.uSelectionWidth,
      uBaseRefl: this.uBaseRefl,
      uDebugTint: this.uDebugTint,
      uFacingEdge0: this.uFacingEdge0,
      uFacingEdge1: this.uFacingEdge1,
      uGradeMix: this.uGradeMix,
      uGradeBasicA: this.uGradeBasicA,
      uGradeBasicB: this.uGradeBasicB,
      uGradeWheelSh: this.uGradeWheelSh,
      uGradeWheelMd: this.uGradeWheelMd,
      uGradeWheelHi: this.uGradeWheelHi,
      uGradeCross: this.uGradeCross,
      uGradeSec0: this.uGradeSec[0],
      uGradeSec1: this.uGradeSec[1],
      uGradeSec2: this.uGradeSec[2],
      uGradeSec3: this.uGradeSec[3],
      uGradeSec4: this.uGradeSec[4],
      uGradeSec5: this.uGradeSec[5],
      uGradeSec6: this.uGradeSec[6],
      uGradeSec7: this.uGradeSec[7],
      uGradeToneMode: this.uGradeToneMode,
    });
  }

  /**
   * Apply a packed Photoshock color grade to the masked paint splats. Pass a
   * {@link PackedGrade} (from `packGrade(preset.data)`) to recolor, or call
   * {@link clearGrade} to revert to the white base.
   */
  setGrade(packed: PackedGrade): void {
    const v = gradeToVectors(packed);
    this.uGradeBasicA.value.copy(v.basicA);
    this.uGradeBasicB.value.copy(v.basicB);
    this.uGradeWheelSh.value.copy(v.wheelSh);
    this.uGradeWheelMd.value.copy(v.wheelMd);
    this.uGradeWheelHi.value.copy(v.wheelHi);
    this.uGradeCross.value.copy(v.cross);
    for (let i = 0; i < 8; i++) this.uGradeSec[i].value.copy(v.sectors[i]);
    this.uGradeToneMode.value = v.toneMode;
    this.uGradeMix.value = 1;
    this.bumpAll();
  }

  /** Revert paint to the white base (no grade). */
  clearGrade(): void {
    this.uGradeMix.value = 0;
    this.bumpAll();
  }

  applyToExterior(key: string, group: THREE.Group): void {
    const mesh = group.children[0] as SplatMesh | undefined;
    if (!mesh) return;

    this.applied = this.applied.filter((e) => e.key !== key);

    if (this.enabled) {
      mesh.worldModifier = this.modifier;
      mesh.updateGenerator();
      mesh.updateVersion();
    }
    this.applied.push({ key, mesh, group });

    this.recomputeMaskFromMesh(mesh, group, key);
  }

  private recomputeMaskFromMesh(
    mesh: SplatMesh,
    group: THREE.Group,
    key: string
  ): void {
    let localBox: THREE.Box3 | undefined;
    try {
      localBox = mesh.getBoundingBox(true);
    } catch {
      localBox = undefined;
    }

    group.updateWorldMatrix(true, true);
    mesh.updateWorldMatrix(true, false);

    let worldBox: THREE.Box3;
    if (localBox && !localBox.isEmpty() && isFinite(localBox.min.x)) {
      worldBox = localBox.clone().applyMatrix4(mesh.matrixWorld);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        "[clearcoat] getBoundingBox returned empty for",
        key,
        "— using fallback radius."
      );
      const fallbackCenter = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
      worldBox = new THREE.Box3(
        fallbackCenter.clone().subScalar(2.5),
        fallbackCenter.clone().addScalar(2.5)
      );
    }

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    worldBox.getCenter(center);
    worldBox.getSize(size);
    const radius = 0.5 * size.length() * 1.05 * this.maskRadiusScale;
    const bottomY = worldBox.min.y + size.y * this.bottomFraction;
    this.uMaskCenter.value.copy(center);
    this.uMaskRadius.value = radius;
    this.uMaskBottomY.value = bottomY;
    this.bumpAll();

    // eslint-disable-next-line no-console
    console.log(
      "[clearcoat] attached to",
      key,
      "→ maskCenter",
      center.toArray().map((n) => +n.toFixed(3)),
      "maskRadius",
      +radius.toFixed(3),
      "bottomY",
      +bottomY.toFixed(3)
    );
  }

  updateView(camera: THREE.Camera): void {
    this.uViewPos.value.copy(camera.position);
  }

  setEnvMap(texture: THREE.Texture): void {
    this.uEnvMap.value = texture;
    this.bumpAll();
  }

  /**
   * No HDRI ("none") — fall back to the DEFAULT flat-white environment so the
   * clearcoat still shows its default look (not a black env, which would zero it).
   */
  clearEnvMap(): void {
    this.uEnvMap.value = makeDefaultEnvTexture();
    this.bumpAll();
  }

  setSelectionMask(texture: THREE.Texture, width: number): void {
    this.uSelectionTex.value = texture;
    this.uSelectionWidth.value = width;
    this.bumpAll();
  }

  setBaseRefl(v: number): void {
    this.uBaseRefl.value = v;
    this.bumpAll();
  }

  setDebugTint(v: number): void {
    this.uDebugTint.value = v;
    this.bumpAll();
  }

  clearSelectionMask(): void {
    this.uSelectionTex.value = makeEmptyMaskTexture();
    this.uSelectionWidth.value = 1;
    this.bumpAll();
  }

  setEnvIntensity(v: number): void {
    this.uEnvIntensity.value = v;
    this.bumpAll();
  }

  setStrength(v: number): void {
    this.uCoatStrength.value = v;
    this.bumpAll();
  }

  setPower(v: number): void {
    this.uCoatPower.value = v;
    this.bumpAll();
  }

  setTint(r: number, g: number, b: number): void {
    this.uCoatTint.value.set(r, g, b);
    this.bumpAll();
  }

  setMaskRadius(v: number): void {
    this.uMaskRadius.value = v;
    this.bumpAll();
  }

  setMaskCenter(x: number, y: number, z: number): void {
    this.uMaskCenter.value.set(x, y, z);
    this.bumpAll();
  }

  /**
   * Scale the whole sphere mask relative to its auto-fit radius. 1 = body-fit,
   * >1 widens the coated area outward, <1 shrinks it. Recomputes from the
   * current body so it survives color/model swaps.
   */
  setMaskRadiusScale(s: number): void {
    this.maskRadiusScale = s;
    const last = this.applied[this.applied.length - 1];
    if (last) this.recomputeMaskFromMesh(last.mesh, last.group, last.key);
  }

  setMaskBottomY(v: number): void {
    this.uMaskBottomY.value = v;
    this.bumpAll();
  }

  setBottomFraction(f: number): void {
    this.bottomFraction = f;
    const last = this.applied[this.applied.length - 1];
    if (last) this.recomputeMaskFromMesh(last.mesh, last.group, last.key);
  }

  setMaskBottomFeather(v: number): void {
    this.bottomFeather = v;
    this.uMaskBottomFeather.value = v;
    this.bumpAll();
  }

  /**
   * How far the effect wraps around to back-facing splats (e.g. the tail when
   * viewed from the front 3/4). 0 = original side-only highlight; 1 = no
   * back-face suppression (whole body, including faces pointing away).
   */
  setWrap(w: number): void {
    const edge1 = 0.35 - w * 1.35;
    this.uFacingEdge1.value = edge1;
    this.uFacingEdge0.value = edge1 - 0.3;
    this.bumpAll();
  }

  enable(on = true): void {
    if (on === this.enabled) return;
    this.enabled = on;
    for (const entry of this.applied) {
      entry.mesh.worldModifier = on ? this.modifier : undefined;
      entry.mesh.updateGenerator();
      entry.mesh.updateVersion();
    }
  }

  status(): void {
    // eslint-disable-next-line no-console
    console.log("[clearcoat]", {
      enabled: this.enabled,
      attached: this.applied.map((e) => e.key),
      strength: this.uCoatStrength.value,
      power: this.uCoatPower.value,
      envIntensity: this.uEnvIntensity.value,
      tint: this.uCoatTint.value.toArray(),
      maskCenter: this.uMaskCenter.value.toArray(),
      maskRadius: this.uMaskRadius.value,
      maskBottomY: this.uMaskBottomY.value,
      bottomFraction: this.bottomFraction,
      maskBottomFeather: this.uMaskBottomFeather.value,
    });
  }

  private bumpAll(): void {
    for (const entry of this.applied) {
      entry.mesh.updateVersion();
    }
  }

  installConsoleHooks(): void {
    if (typeof window === "undefined") return;
    if (globalThis.__clearcoat) return;
    const api: ClearcoatConsoleApi = {
      setStrength: (v) => this.setStrength(v),
      setPower: (v) => this.setPower(v),
      setEnvIntensity: (v) => this.setEnvIntensity(v),
      setTint: (r, g, b) => this.setTint(r, g, b),
      setMaskRadius: (v) => this.setMaskRadius(v),
      setMaskRadiusScale: (s) => this.setMaskRadiusScale(s),
      setMaskCenter: (x, y, z) => this.setMaskCenter(x, y, z),
      setMaskBottomY: (v) => this.setMaskBottomY(v),
      setBottomFraction: (f) => this.setBottomFraction(f),
      setMaskBottomFeather: (v) => this.setMaskBottomFeather(v),
      setWrap: (w) => this.setWrap(w),
      enable: (on = true) => this.enable(on),
      status: () => this.status(),
    };
    globalThis.__clearcoat = api;
    // eslint-disable-next-line no-console
    console.log(
      "%c[clearcoat] HDRI env reflections — live tuning ready",
      "color:#9cf;font-weight:bold",
      "\n  __clearcoat.setStrength(0.0..1.0)",
      "\n  __clearcoat.setPower(1..16)            // fresnel exponent",
      "\n  __clearcoat.setEnvIntensity(0..5)      // HDRI brightness multiplier",
      "\n  __clearcoat.setTint(r, g, b)            // try (1, 1, 1.1) for cool",
      "\n  __clearcoat.setMaskRadius(meters)",
      "\n  __clearcoat.setMaskCenter(x, y, z)",
      "\n  __clearcoat.setBottomFraction(0..1)     // 0=no cutoff, 0.35≈wheel-arch",
      "\n  __clearcoat.setMaskBottomY(worldY)",
      "\n  __clearcoat.setMaskBottomFeather(m)",
      "\n  __clearcoat.enable(false)               // toggle off",
      "\n  __clearcoat.status()"
    );
  }
}
