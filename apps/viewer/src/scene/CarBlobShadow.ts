import * as THREE from "three";
import { createContactShadowDiskGroup } from "@changan/scene-runtime/contactShadow";
import { assetKey, getScale, resolveContactShadowGradient } from "@changan/shared";
import type { SceneManifest, TransformDef } from "@changan/shared";
import type { AssetManager } from "./AssetManager.js";
import type { StateStore } from "./StateStore.js";

/**
 * Manifest-driven contact shadow (world transform). Hidden when exterior splat is not visible.
 */
export class CarBlobShadow {
  readonly group: THREE.Group;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly applyResolvedGradient: (g: ReturnType<typeof resolveContactShadowGradient>) => void;
  private readonly applyCornerRadiusFromManifest: (manifestCorner01?: number) => void;
  private readonly disposeDisk: () => void;

  constructor() {
    const { group, material, applyResolvedGradient, setCornerRadiusT, dispose } =
      createContactShadowDiskGroup(0.92);
    this.group = group;
    this.material = material;
    this.applyResolvedGradient = applyResolvedGradient;
    this.applyCornerRadiusFromManifest = setCornerRadiusT;
    this.disposeDisk = dispose;
    this.group.name = "CarBlobShadow";
    this.group.userData.isContactShadow = true;
  }

  private applyTransform(t: TransformDef): void {
    this.group.position.set(t.pos[0], t.pos[1], t.pos[2]);
    this.group.quaternion.set(t.rot[0], t.rot[1], t.rot[2], t.rot[3]);
    const [sx, sy, sz] = getScale(t);
    this.group.scale.set(sx, sy, sz);
  }

  sync(
    assetManager: AssetManager,
    manifest: SceneManifest | null,
    stateStore: StateStore | null
  ): void {
    if (!manifest || !stateStore) {
      this.group.visible = false;
      return;
    }
    const st = stateStore.getState();
    const model = manifest.models.find((x) => x.id === st.modelId);
    if (!model?.contactShadow) {
      this.group.visible = false;
      return;
    }
    const extKey = assetKey(st.modelId, st.colorId, "exterior");
    const ext = assetManager.getCached(extKey);
    if (!ext?.visible) {
      this.group.visible = false;
      return;
    }
    const op = model.contactShadow.opacity ?? 0.9;
    this.material.opacity = op;
    this.applyCornerRadiusFromManifest(model.contactShadow.cornerRadius);
    this.applyResolvedGradient(resolveContactShadowGradient(model.contactShadow.gradient));
    this.applyTransform(model.contactShadow.transform);
    this.group.visible = true;
  }

  dispose(): void {
    this.disposeDisk();
  }
}
