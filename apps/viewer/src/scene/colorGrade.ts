import * as THREE from "three";

/**
 * Photoshock "photoshock-color-grade" pipeline, ported 1:1 from
 * `F:\dev\Photoshock\photoshock\src\main.js` (`sp_color_grade` / `cpuSpColorGrade`)
 * for use inside a Spark dyno worldModifier.
 *
 * The `{model}_{color}_color.json` presets are authored by Photoshock; matching
 * its math exactly is the whole point, so the GLSL below mirrors `sp_*` verbatim
 * and the JS packer mirrors `cpuSpColorGrade`'s per-stage enable handling by
 * baking disabled stages into neutral uniform values (so the shader can always
 * run the full pipeline without boolean branches).
 *
 * NOTE: 3D LUT (`uGradeLut*`) and non-linear tone maps are supported by
 * Photoshock but every current Changan preset uses toneMode 0 (Linear) with no
 * LUT, so this port implements exposure → tone map (modes 0..5) → levels →
 * contrast → sectors → saturation → temp/tint → split tones. LUT is omitted
 * (lutSize:0 / lutRgb:null in every preset); add it here if a preset ever ships one.
 */

/** The `data` block of a `{model}_{color}_color.json` preset. */
export interface ColorGradeData {
  enabled?: boolean;
  toneLutEnabled?: boolean;
  exposureLevelsEnabled?: boolean;
  saturationBalanceEnabled?: boolean;
  splitTonesEnabled?: boolean;
  splitShadowEnabled?: boolean;
  splitMidEnabled?: boolean;
  splitHighEnabled?: boolean;
  colorChannelsEnabled?: boolean;
  exposure?: number;
  contrast?: number;
  blackPoint?: number;
  whitePoint?: number;
  saturation?: number;
  temperature?: number;
  tint?: number;
  wheelShadowHex?: string;
  wheelShadowAmt?: number;
  wheelMidHex?: string;
  wheelMidAmt?: number;
  wheelHighHex?: string;
  wheelHighAmt?: number;
  sectors?: Array<{ h: number; s: number; l: number }>;
  toneMode?: number;
}

export interface ColorGradePreset {
  type?: string;
  version?: number;
  data: ColorGradeData;
}

/**
 * Effective, flag-resolved uniform values for the grade — the result of baking
 * Photoshock's per-stage enable flags into neutral values (mirrors cpuSpColorGrade).
 */
export interface PackedGrade {
  /** exposure(EV), contrast, blackPoint, whitePoint */
  basicA: [number, number, number, number];
  /** saturation, temperature, tint, 0 */
  basicB: [number, number, number, number];
  wheelSh: [number, number, number];
  wheelMd: [number, number, number];
  wheelHi: [number, number, number];
  /** shadow/mid/highlight luminance split thresholds (Photoshock constant) */
  cross: [number, number, number, number];
  /** 8 sector HSL adjustments (h,s,l), already zeroed if colorChannels disabled */
  sectors: Array<[number, number, number]>;
  toneMode: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function hexToRgb01(hex: string): [number, number, number] {
  const h = typeof hex === "string" && hex.length >= 7 ? hex : "#808080";
  const r = parseInt(h.slice(1, 3), 16) / 255;
  const g = parseInt(h.slice(3, 5), 16) / 255;
  const b = parseInt(h.slice(5, 7), 16) / 255;
  return [r, g, b];
}

/** Photoshock `wheelRgbOffset`: (rgb-0.5)*2*amt — additive split-tone offset. */
function wheelRgbOffset(hex: string | undefined, amt: number | undefined): [number, number, number] {
  const [r, g, b] = hexToRgb01(hex ?? "#808080");
  const a = clamp(Number(amt) || 0, 0, 1);
  return [(r - 0.5) * 2 * a, (g - 0.5) * 2 * a, (b - 0.5) * 2 * a];
}

/**
 * Bake a preset's `data` into flag-resolved uniform values. Mirrors the flag
 * handling in Photoshock's `cpuSpColorGrade` so disabled stages become neutral.
 */
export function packGrade(data: ColorGradeData): PackedGrade {
  const toneLutOn = data.toneLutEnabled !== false;
  const exposureLevelsOn = data.exposureLevelsEnabled !== false;
  const satBalanceOn = data.saturationBalanceEnabled !== false;
  const splitGlobalOn = data.splitTonesEnabled !== false;
  const splitShOn = splitGlobalOn && data.splitShadowEnabled !== false;
  const splitMdOn = splitGlobalOn && data.splitMidEnabled !== false;
  const splitHiOn = splitGlobalOn && data.splitHighEnabled !== false;
  const colorChannelsOn = data.colorChannelsEnabled !== false;

  // toneLut gate also zeroes exposure + forces linear tone map (per cpuSpColorGrade).
  const exposure = toneLutOn ? clamp(Number(data.exposure) || 0, -4, 4) : 0;
  const toneMode = toneLutOn ? Math.max(0, Math.min(5, Math.floor(Number(data.toneMode) || 0))) : 0;

  const blackPoint = exposureLevelsOn ? clamp(Number(data.blackPoint) || 0, 0, 0.95) : 0;
  const whitePointRaw = exposureLevelsOn ? clamp(Number(data.whitePoint) || 1, 0.05, 1) : 1;
  const contrast = exposureLevelsOn ? clamp(Number(data.contrast) || 1, 0.1, 3) : 1;

  const saturation = satBalanceOn ? clamp(Number(data.saturation) ?? 1, 0, 2) : 1;
  const temperature = satBalanceOn ? clamp(Number(data.temperature) || 0, -1, 1) : 0;
  const tint = satBalanceOn ? clamp(Number(data.tint) || 0, -1, 1) : 0;

  const zero: [number, number, number] = [0, 0, 0];
  const wheelSh = splitShOn ? wheelRgbOffset(data.wheelShadowHex, data.wheelShadowAmt) : zero;
  const wheelMd = splitMdOn ? wheelRgbOffset(data.wheelMidHex, data.wheelMidAmt) : zero;
  const wheelHi = splitHiOn ? wheelRgbOffset(data.wheelHighHex, data.wheelHighAmt) : zero;

  const srcSectors = Array.isArray(data.sectors) ? data.sectors : [];
  const sectors: Array<[number, number, number]> = Array.from({ length: 8 }, (_, i) => {
    if (!colorChannelsOn) return [0, 0, 0];
    const s = srcSectors[i];
    return [s?.h ?? 0, s?.s ?? 0, s?.l ?? 0];
  });

  return {
    basicA: [exposure, contrast, blackPoint, whitePointRaw],
    basicB: [saturation, temperature, tint, 0],
    wheelSh,
    wheelMd,
    wheelHi,
    cross: [0.2, 0.45, 0.55, 0.8],
    sectors,
    toneMode,
  };
}

/** Identity grade (no recolor) — used for the base/white color. */
export const IDENTITY_GRADE: PackedGrade = {
  basicA: [0, 1, 0, 1],
  basicB: [1, 0, 0, 0],
  wheelSh: [0, 0, 0],
  wheelMd: [0, 0, 0],
  wheelHi: [0, 0, 0],
  cross: [0.2, 0.45, 0.55, 0.8],
  sectors: Array.from({ length: 8 }, () => [0, 0, 0] as [number, number, number]),
  toneMode: 0,
};

/**
 * GLSL globals — ported verbatim from Photoshock `sp_*`, but with the grade
 * params passed as function arguments instead of global uniforms so the dyno
 * uniform system can manage them. Function names are prefixed `cg_` to avoid
 * colliding with any Spark-internal `sp_*`.
 */
export const COLOR_GRADE_GLSL = `
vec3 cg_uch(vec3 x){
  const float A=0.15,B=0.50,C=0.10,D=0.20,E=0.02,F=0.30;
  return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;
}
vec3 cg_neutral_tm(vec3 color){
  const float startCompression=0.8-0.04; const float desaturation=0.15;
  float x=min(color.r,min(color.g,color.b));
  float offset=x<0.08?x-6.25*x*x:0.04;
  color-=vec3(offset);
  float peak=max(color.r,max(color.g,color.b));
  if(peak<startCompression) return color;
  float d=1.0-startCompression;
  float newPeak=1.0-d*d/(peak+d-startCompression);
  color*=newPeak/max(peak,1e-6);
  float g=1.0-1.0/(desaturation*(peak-newPeak)+1.0);
  return mix(color,vec3(newPeak),g);
}
vec3 cg_rrt_odt_fit(vec3 v){
  vec3 a=v*(v+0.0245786)-0.000090537;
  vec3 b=v*(0.983729*v+0.4329510)+0.238081;
  return a/b;
}
vec3 cg_aces2_tm(vec3 color){
  const mat3 inMat=mat3(0.59719,0.07600,0.02840,0.35458,0.90834,0.13383,0.04823,0.01566,0.83777);
  const mat3 outMat=mat3(1.60475,-0.10208,-0.00327,-0.53108,1.10813,-0.07276,-0.07367,-0.00605,1.07602);
  vec3 v=inMat*color; v=cg_rrt_odt_fit(v); return outMat*v;
}
vec3 cg_hejl_tm(vec3 x){
  vec3 c=max(vec3(0.0),x-vec3(0.004));
  return (c*(6.2*c+0.5))/(c*(6.2*c+1.7)+0.06);
}
vec3 cg_tone_map(vec3 x,int mode){
  if(mode<=0) return clamp(x,0.0,1.0);
  if(mode==1) return clamp(cg_neutral_tm(x),0.0,1.0);
  if(mode==2) return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0);
  if(mode==3) return clamp(cg_aces2_tm(x),0.0,1.0);
  if(mode==4) return clamp(cg_uch(x)/cg_uch(vec3(11.2)),0.0,1.0);
  return clamp(cg_hejl_tm(x),0.0,1.0);
}
vec3 cg_rgb2hsv(vec3 c){
  vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);
  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));
  float d=q.x-min(q.w,q.y); float e=1.0e-10;
  return vec3(abs(q.z+(q.w-q.y)/(6.0*d+e)),d/(q.x+e),q.x);
}
vec3 cg_hsv2rgb(vec3 c){
  vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
  vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
  return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
}
vec3 cg_sectors(vec3 rgb, vec3 s0,vec3 s1,vec3 s2,vec3 s3,vec3 s4,vec3 s5,vec3 s6,vec3 s7){
  vec3 hsv=cg_rgb2hsv(clamp(rgb,0.0,1.0));
  float fsec=hsv.x*8.0;
  vec3 adj=s0;
  if(fsec>=1.0) adj=s1;
  if(fsec>=2.0) adj=s2;
  if(fsec>=3.0) adj=s3;
  if(fsec>=4.0) adj=s4;
  if(fsec>=5.0) adj=s5;
  if(fsec>=6.0) adj=s6;
  if(fsec>=7.0) adj=s7;
  hsv.x=fract(hsv.x+adj.x);
  hsv.y=clamp(hsv.y*(1.0+adj.y),0.0,1.0);
  hsv.z=clamp(hsv.z+adj.z,0.0,1.0);
  return cg_hsv2rgb(hsv);
}
vec3 cg_color_grade(vec3 col, float Lsplit, vec4 A, vec4 B, vec3 wSh, vec3 wMd, vec3 wHi, vec4 cross,
                    vec3 s0,vec3 s1,vec3 s2,vec3 s3,vec3 s4,vec3 s5,vec3 s6,vec3 s7, int toneMode){
  vec3 g=col*exp2(A.x);
  g=cg_tone_map(g,toneMode);
  float bp=A.z; float wp=max(A.w,bp+1e-4);
  g=(g-bp)/max(wp-bp,1e-4);
  g=(g-0.5)*A.y+0.5;
  g=clamp(g,0.0,1.0);
  g=cg_sectors(g,s0,s1,s2,s3,s4,s5,s6,s7);
  float lu=dot(g,vec3(0.2126,0.7152,0.0722));
  g=mix(vec3(lu),g,clamp(B.x,0.0,4.0));
  g.r+=B.y*0.14; g.b-=B.y*0.14;
  g.r+=B.z*0.10; g.g-=B.z*0.10;
  float sw=1.0-smoothstep(cross.x,cross.y,Lsplit);
  float mw=smoothstep(cross.x,cross.y,Lsplit)*(1.0-smoothstep(cross.z,cross.w,Lsplit));
  float hw=smoothstep(cross.z,cross.w,Lsplit);
  g+=wSh*sw+wMd*mw+wHi*hw;
  return clamp(g,0.0,1.0);
}
`;

/** Convenience: a flat THREE.Vector4/Vector3 set of uniform values for a packed grade. */
export function gradeToVectors(p: PackedGrade): {
  basicA: THREE.Vector4;
  basicB: THREE.Vector4;
  wheelSh: THREE.Vector3;
  wheelMd: THREE.Vector3;
  wheelHi: THREE.Vector3;
  cross: THREE.Vector4;
  sectors: THREE.Vector3[];
  toneMode: number;
} {
  return {
    basicA: new THREE.Vector4(...p.basicA),
    basicB: new THREE.Vector4(...p.basicB),
    wheelSh: new THREE.Vector3(...p.wheelSh),
    wheelMd: new THREE.Vector3(...p.wheelMd),
    wheelHi: new THREE.Vector3(...p.wheelHi),
    cross: new THREE.Vector4(...p.cross),
    sectors: p.sectors.map((s) => new THREE.Vector3(...s)),
    toneMode: p.toneMode,
  };
}
