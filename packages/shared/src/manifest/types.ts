export type ViewMode = "exterior" | "motor" | "interior";

export interface TransformDef {
  pos: [number, number, number];
  rot: [number, number, number, number]; // quaternion xyzw
  /** Uniform scale, or per-axis [x, y, z]. Default 1. */
  scale: number | [number, number, number];
  /** Pivot point in model local space. Transform (scale/rotate) happens around this point. Default [0,0,0]. */
  pivot?: [number, number, number];
  /** Pivot orientation (quaternion xyzw). Affects the rotation axes. Default identity [0,0,0,1]. */
  pivotRot?: [number, number, number, number];
}

export type SplatFileType = "ply" | "spz" | "splat" | "ksplat" | "sogs" | "zip";

export interface AssetDef {
  url: string;
  /**
   * Explicit file type override. Required when the URL has no recognized
   * extension. ".sogs" files MUST be loaded via URL (not bytes); the asset
   * manager handles this automatically based on extension or this field.
   */
  fileType?: SplatFileType;
  lod?: { mobile?: string; desktop?: string };
  transform: TransformDef;
  meta?: { splatCount?: number; sizeBytes?: number };
}

/**
 * Splat layer kinds for a FOTON model:
 * - `base` — the bare vehicle (`splats/<id>/<id>.sog`), always the default view.
 * - `accessory` — one attachment shown at a time on top of the base
 *   (`splats/<id>/<id>-<accessoryId>.sog`).
 * - `motor` — engine detail splat (`splats/<id>/<id>-motor.sog`).
 * - `interior` — cabin splat (`splats/<id>/<id>-int.sog`).
 */
export type SplatLayerKind = "base" | "accessory" | "motor" | "interior";

/**
 * An attachment splat aligned on top of the base model (furgón, tanque, …).
 * The viewer shows at most one accessory at a time.
 */
export interface AccessoryDef {
  id: string;
  name: string;
  asset: AssetDef;
}

/**
 * Dormant color-variant concept (paint mask / color-grade shader system).
 * FOTON models currently ship without color variants; the paint pipeline in
 * the viewer stays in the codebase and reactivates if a model declares colors.
 */
export interface ColorDef {
  id: string;
  name: string;
}

export interface CameraBookmark {
  pos: [number, number, number];
  target: [number, number, number];
}

/** How the user controls the camera for this bookmark. */
export type CameraInteractionMode = "orbit" | "freelook";

/** Named camera bookmark with saved layer visibility */
export interface NamedCameraBookmark {
  id: string;
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
  /**
   * Layer visibility when this bookmark was created. The `accessory` flag
   * applies to whichever accessory is currently selected in the viewer —
   * bookmarks frame views, the accessory selector decides which attachment.
   */
  visibility: Record<SplatLayerKind, boolean>;
  /** Orbit constraints (degrees). X = azimuth, Y = polar. */
  azimuthMin?: number;
  azimuthMax?: number;
  polarMin?: number;
  polarMax?: number;
  /** Vertical field of view in degrees (PerspectiveCamera.fov). Default 60. */
  fov?: number;
  /** OrbitControls: minimum camera distance from target (world units). Default 0. */
  minDistance?: number;
  /** OrbitControls: maximum camera distance from target. Omit for unlimited. */
  maxDistance?: number;
  /**
   * `orbit` — OrbitControls (orbit, zoom, pan as configured).
   * `freelook` — fixed eye position (`pos`); drag to look around only (for interiors).
   */
  cameraMode?: CameraInteractionMode;
  /** Depth of field: focal plane distance (world units). */
  focalDistance?: number;
  /** Depth of field: aperture size (world units). Blur strength. */
  apertureSize?: number;
}

export interface AnnotationDef {
  id: string;
  view: ViewMode;
  pos: [number, number, number];
  text: string;
  bookmarkId?: string;
}

export interface ModelDef {
  id: string;
  name: string;
  /** Bare vehicle splat — always loaded, the default view. */
  base: AssetDef;
  /** Attachments shown one at a time on top of the base. May be empty. */
  accessories: AccessoryDef[];
  /** Engine detail splat (`<id>-motor.sog`). Optional until captured. */
  motor?: AssetDef;
  /** Cabin splat (`<id>-int.sog`). Optional until captured. */
  interior?: AssetDef;
  /** Dormant color variants — see {@link ColorDef}. */
  colors?: ColorDef[];
  /**
   * 3D nameplate mesh `splats/<id>/<id>.glb` (aligned in the editor, rendered
   * by the viewer). `tint` (hex) overrides the mesh base color.
   */
  nameplate3d?: { transform: TransformDef; tint?: string };
  /**
   * Floor contact-shadow (rounded rect, world transform). Per model; edited in the editor
   * (layer + gizmo + opacity + corner radius). Viewer reads it for the active model.
   */
  contactShadow?: {
    transform: TransformDef;
    opacity?: number;
    /**
     * Corner roundness 0–1: fraction of min(half-width, half-depth) in local mesh space
     * (unit half-extents 1×1 before group scale). 0 = sharp rectangle, 1 = pill/stadium.
     */
    cornerRadius?: number;
    /**
     * Radial alpha gradient on the floor disk (resolved with defaults in viewer/editor).
     * `midStop` is normalized radius (0–1) between center and edge.
     */
    gradient?: {
      centerAlpha?: number;
      midStop?: number;
      midAlpha?: number;
      edgeAlpha?: number;
    };
  };
  /** Legacy per-view default cameras. `cameraBookmarks` is the real navigation. */
  bookmarks?: Partial<Record<ViewMode, CameraBookmark>>;
  /** Named camera bookmarks with visibility. Editor uses these. */
  cameraBookmarks?: NamedCameraBookmark[];
  annotations: AnnotationDef[];
}

/** Linear distance fog (softens depth / backdrop). */
export interface SceneFogDef {
  enabled?: boolean;
  color: string;
  near: number;
  far: number;
}

export interface SceneLightingDef {
  ambient?: { color: string; intensity: number };
  directional?: {
    color: string;
    intensity: number;
    pos: [number, number, number];
  };
  fog?: SceneFogDef;
}

/** Canvas clear color, lights, and fog — editor + viewer. */
export interface SceneStyleDef {
  backgroundColor?: string;
  lighting?: SceneLightingDef;
}

export interface SceneManifest {
  version: number;
  cdnBaseUrl?: string;
  defaults: {
    modelId: string;
    /** Accessory selected at boot. Omit for base-only (the default state). */
    accessoryId?: string;
    /** Dormant — only meaningful when the model declares colors. */
    colorId?: string;
    view: ViewMode;
  };
  models: ModelDef[];
  /** Optional dealership background transform (position, rotation, scale). */
  dealership?: { transform: TransformDef };
  /**
   * Optional floor plane `splats/floor.glb` — loaded with the dealership
   * (`?dealer=1` in the viewer; editor shows it with the dealership layer).
   */
  floor?: {
    transform: TransformDef;
    /** Multiplier for mesh base color (default 1). */
    brightness?: number;
  };
  /**
   * Optional ceiling `splats/ceiling.glb` — same load/visibility rules as {@link SceneManifest.floor}.
   */
  ceiling?: {
    transform: TransformDef;
    brightness?: number;
  };
  /**
   * Optional GLB backdrop (blackdrop.glb): transform, tint (hex), tintStrength 0..1.
   */
  blackdrop?: {
    transform: TransformDef;
    tint?: string;
    tintStrength?: number;
  };
  /**
   * Optional scene-wide brand nameplate GLB — same visibility rule as backdrop: in the
   * viewer only when `?backdrop=1`; in the editor, shown/hidden with the blackdrop toggle.
   * `tint` (hex) sets an absolute color for the nameplate meshes; when absent
   * they render at their base albedo brightened 15% (the lighter-gray default).
   */
  changan3D?: { transform: TransformDef; tint?: string };
  /**
   * Optional equirectangular JPG/PNG painted on the inside of a large sphere that wraps
   * the dealership scene. Loaded with the dealership layer (desktop or `?dealer=1`).
   * Editable from the editor with the standard transform gizmo.
   */
  panoBackground?: {
    /** Equirect image URL — same `/splats/...` resolution rules as splat assets. */
    url: string;
    transform: TransformDef;
    /** Multiplier on the texture color (0..4). Default 1. */
    brightness?: number;
  };
  /** Scene background color, lights, fog. */
  scene?: SceneStyleDef;
}
