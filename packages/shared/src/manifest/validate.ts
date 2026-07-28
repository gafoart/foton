import { z } from "zod";

const viewModeSchema = z.enum(["exterior", "detail", "interior"]);

const cameraInteractionModeSchema = z.enum(["orbit", "freelook"]);

const transformDefSchema = z.object({
  pos: z.tuple([z.number(), z.number(), z.number()]),
  rot: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  scale: z.union([z.number(), z.tuple([z.number(), z.number(), z.number()])]),
  pivot: z.tuple([z.number(), z.number(), z.number()]).optional(),
  pivotRot: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

const splatFileTypeSchema = z
  .enum(["ply", "spz", "splat", "ksplat", "sogs", "zip"])
  .optional();

const assetDefSchema = z.object({
  url: z.string().min(1),
  fileType: splatFileTypeSchema,
  lod: z
    .object({
      mobile: z.string().optional(),
      desktop: z.string().optional(),
    })
    .optional(),
  transform: transformDefSchema,
  meta: z
    .object({
      splatCount: z.number().optional(),
      sizeBytes: z.number().optional(),
    })
    .optional(),
});

const colorDefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  assets: z.object({
    exterior: assetDefSchema,
    detail: assetDefSchema,
  }),
});

const cameraBookmarkSchema = z.object({
  pos: z.tuple([z.number(), z.number(), z.number()]),
  target: z.tuple([z.number(), z.number(), z.number()]),
});

const namedCameraBookmarkSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  pos: z.tuple([z.number(), z.number(), z.number()]),
  target: z.tuple([z.number(), z.number(), z.number()]),
  visibility: z.object({
    exterior: z.boolean(),
    detail: z.boolean(),
    interior: z.boolean(),
  }),
  azimuthMin: z.number().nullable().optional().transform(v => v ?? undefined),
  azimuthMax: z.number().nullable().optional().transform(v => v ?? undefined),
  polarMin: z.number().nullable().optional().transform(v => v ?? undefined),
  polarMax: z.number().nullable().optional().transform(v => v ?? undefined),
  fov: z.number().nullable().optional().transform(v => v ?? undefined),
  minDistance: z.number().nullable().optional().transform(v => v ?? undefined),
  maxDistance: z.number().nullable().optional().transform(v => v ?? undefined),
  cameraMode: z
    .union([cameraInteractionModeSchema, z.null()])
    .optional()
    .transform((v) => (v === null ? undefined : v)),
  focalDistance: z.number().nullable().optional().transform(v => v ?? undefined),
  apertureSize: z.number().nullable().optional().transform(v => v ?? undefined),
});

const annotationDefSchema = z.object({
  id: z.string().min(1),
  view: viewModeSchema,
  pos: z.tuple([z.number(), z.number(), z.number()]),
  text: z.string(),
  bookmarkId: z.string().optional(),
});

const modelDefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  colors: z.array(colorDefSchema).min(1),
  interior: assetDefSchema,
  carShell: z
    .object({
      transform: transformDefSchema,
    })
    .optional(),
  contactShadow: z
    .object({
      transform: transformDefSchema,
      opacity: z.number().min(0).max(1).optional(),
      cornerRadius: z.number().min(0).max(1).optional(),
      gradient: z
        .object({
          centerAlpha: z.number().min(0).max(1).optional(),
          midStop: z.number().min(0.02).max(0.999).optional(),
          midAlpha: z.number().min(0).max(1).optional(),
          edgeAlpha: z.number().min(0).max(1).optional(),
        })
        .optional(),
    })
    .optional(),
  bookmarks: z.object({
    exterior: cameraBookmarkSchema,
    detail: cameraBookmarkSchema,
    interior: cameraBookmarkSchema,
  }),
  cameraBookmarks: z.array(namedCameraBookmarkSchema).optional(),
  annotations: z.array(annotationDefSchema),
});

export const sceneManifestSchema = z.object({
  version: z.number(),
  cdnBaseUrl: z.string().optional(),
  defaults: z.object({
    modelId: z.string().min(1),
    colorId: z.string().min(1),
    view: viewModeSchema,
  }),
  models: z.array(modelDefSchema).min(1),
  dealership: z
    .object({
      transform: transformDefSchema,
    })
    .optional(),
  floor: z
    .object({
      transform: transformDefSchema,
      brightness: z.number().min(0).max(4).optional(),
    })
    .optional(),
  ceiling: z
    .object({
      transform: transformDefSchema,
      brightness: z.number().min(0).max(4).optional(),
    })
    .optional(),
  blackdrop: z
    .object({
      transform: transformDefSchema,
      tint: z.string().optional(),
      tintStrength: z.number().min(0).max(1).optional(),
    })
    .optional(),
  changan3D: z
    .object({
      transform: transformDefSchema,
      tint: z.string().optional(),
    })
    .optional(),
  panoBackground: z
    .object({
      url: z.string().min(1),
      transform: transformDefSchema,
      brightness: z.number().min(0).max(4).optional(),
    })
    .optional(),
  scene: z
    .object({
      backgroundColor: z.string().optional(),
      lighting: z
        .object({
          ambient: z
            .object({
              color: z.string(),
              intensity: z.number(),
            })
            .optional(),
          directional: z
            .object({
              color: z.string(),
              intensity: z.number(),
              pos: z.tuple([z.number(), z.number(), z.number()]),
            })
            .optional(),
          fog: z
            .object({
              enabled: z.boolean().optional(),
              color: z.string(),
              near: z.number(),
              far: z.number(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

export type SceneManifestInput = z.input<typeof sceneManifestSchema>;

/**
 * Validates a manifest. Throws ZodError on failure.
 * Returns the parsed manifest on success.
 */
export function validateManifest(
  data: unknown
): z.infer<typeof sceneManifestSchema> {
  return sceneManifestSchema.parse(data);
}

/**
 * Safe validation that returns a result object instead of throwing.
 */
export function validateManifestSafe(data: unknown): z.SafeParseReturnType<
  unknown,
  z.infer<typeof sceneManifestSchema>
> {
  return sceneManifestSchema.safeParse(data);
}
