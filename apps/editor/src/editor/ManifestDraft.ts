import { loadManifestFromStorage, MANIFEST_STORAGE_KEY } from "@changan/shared";
import type { SceneManifest, TransformDef } from "@changan/shared";

export interface ManifestDraftOptions {
  initial?: SceneManifest;
  onChange?: (manifest: SceneManifest) => void;
  persistKey?: string; // localStorage key; set to enable auto-save
}

export class ManifestDraft {
  private _manifest: SceneManifest;
  private onChange?: (manifest: SceneManifest) => void;
  private persistKey?: string;

  constructor({ initial, onChange, persistKey }: ManifestDraftOptions = {}) {
    this._manifest = initial ?? createEmptyManifest();
    this.onChange = onChange;
    this.persistKey = persistKey;
  }

  get manifest(): SceneManifest {
    return this._manifest;
  }

  setManifest(manifest: SceneManifest): void {
    this._manifest = manifest;
    this.onChange?.(this._manifest);
    this.persist();
  }

  /**
   * Restore manifest without triggering onChange (e.g. for undo/redo).
   */
  restoreManifest(manifest: SceneManifest): void {
    this._manifest = manifest;
    this.persist();
  }

  private persist(): void {
    if (!this.persistKey || typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(this.persistKey, JSON.stringify(this._manifest));
    } catch {
      // ignore quota/parsing errors
    }
  }

  static loadFromStorage(key: string = MANIFEST_STORAGE_KEY): SceneManifest | null {
    return loadManifestFromStorage(key);
  }

  loadFromJson(json: string): void {
    const data = JSON.parse(json) as SceneManifest;
    this._manifest = data;
    this.onChange?.(this._manifest);
    this.persist();
  }

  copyTransformsFromColor(
    modelId: string,
    fromColorId: string,
    toColorIds: string[]
  ): void {
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model) return;
    const fromColor = model.colors.find((c) => c.id === fromColorId);
    if (!fromColor) return;

    for (const toColorId of toColorIds) {
      if (toColorId === fromColorId) continue;
      const toColor = model.colors.find((c) => c.id === toColorId);
      if (!toColor) continue;

      toColor.assets.exterior.transform = { ...fromColor.assets.exterior.transform };
      toColor.assets.detail.transform = { ...fromColor.assets.detail.transform };
    }
    this.onChange?.(this._manifest);
  }

  updateDealershipTransform(transform: TransformDef): void {
    if (!this._manifest.dealership) {
      this._manifest.dealership = { transform: { ...transform } };
    } else {
      this._manifest.dealership.transform = { ...transform };
    }
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateFloorTransform(transform: TransformDef): void {
    if (!this._manifest.floor) {
      this._manifest.floor = { transform: { ...transform } };
    } else {
      this._manifest.floor.transform = { ...transform };
    }
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateCeilingTransform(transform: TransformDef): void {
    if (!this._manifest.ceiling) {
      this._manifest.ceiling = { transform: { ...transform } };
    } else {
      this._manifest.ceiling.transform = { ...transform };
    }
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateBlackdropTransform(transform: TransformDef): void {
    if (!this._manifest.blackdrop) {
      this._manifest.blackdrop = { transform: { ...transform } };
    } else {
      this._manifest.blackdrop.transform = { ...transform };
    }
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateChangan3DTransform(transform: TransformDef): void {
    if (!this._manifest.changan3D) {
      this._manifest.changan3D = { transform: { ...transform } };
    } else {
      this._manifest.changan3D.transform = { ...transform };
    }
    this.onChange?.(this._manifest);
    this.persist();
  }

  updatePanoBackgroundTransform(transform: TransformDef): void {
    if (!this._manifest.panoBackground) {
      // Caller provides the transform; URL must be set elsewhere first (defaults applied
      // when the editor loads a manifest that lacks panoBackground entirely).
      this._manifest.panoBackground = {
        url: "/splats/pano_bg.jpg",
        transform: { ...transform },
      };
    } else {
      this._manifest.panoBackground = {
        ...this._manifest.panoBackground,
        transform: { ...transform },
      };
    }
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateCarShellTransform(modelId: string, transform: TransformDef): void {
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model) return;
    model.carShell = { transform: { ...transform } };
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateContactShadowTransform(modelId: string, transform: TransformDef): void {
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model?.contactShadow) return;
    model.contactShadow = {
      ...model.contactShadow,
      transform: { ...transform },
    };
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateContactShadowOpacity(modelId: string, opacity: number): void {
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model || !model.contactShadow) return;
    model.contactShadow = {
      ...model.contactShadow,
      opacity: Math.max(0, Math.min(1, opacity)),
    };
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateContactShadowGradient(
    modelId: string,
    partial: {
      centerAlpha?: number;
      midStop?: number;
      midAlpha?: number;
      edgeAlpha?: number;
    }
  ): void {
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model?.contactShadow) return;
    model.contactShadow = {
      ...model.contactShadow,
      gradient: { ...(model.contactShadow.gradient ?? {}), ...partial },
    };
    this.onChange?.(this._manifest);
    this.persist();
  }

  updateContactShadowCornerRadius(modelId: string, cornerRadius: number): void {
    const model = this._manifest.models.find((m) => m.id === modelId);
    if (!model?.contactShadow) return;
    model.contactShadow = {
      ...model.contactShadow,
      cornerRadius: Math.max(0, Math.min(1, cornerRadius)),
    };
    this.onChange?.(this._manifest);
    this.persist();
  }

  /** Local edits (scene style, tint, etc.); keeps transform-only updates separate. */
  patchManifest(mutator: (m: SceneManifest) => void): void {
    mutator(this._manifest);
    this.onChange?.(this._manifest);
    this.persist();
  }

  copyBookmarksFromModel(
    fromModelId: string,
    toModelId: string
  ): void {
    const fromModel = this._manifest.models.find((m) => m.id === fromModelId);
    const toModel = this._manifest.models.find((m) => m.id === toModelId);
    if (!fromModel || !toModel) return;

    toModel.bookmarks = { ...fromModel.bookmarks };
    this.onChange?.(this._manifest);
  }
}

function createEmptyManifest(): SceneManifest {
  return {
    version: 1,
    defaults: {
      modelId: "",
      colorId: "",
      view: "exterior",
    },
    models: [],
  };
}
