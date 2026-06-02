import type { ProviderRef, BuiltinProvider } from "@/lib/model-router";
import type { ModelMeta } from "@/lib/model-router/providers/registry";
import { resolveModelVision, resolveModelMeta } from "@/lib/model-router/providers/registry";

/**
 * Resolve whether (provider, model) supports vision, for the attach-image gate.
 * Order: registry → instance fetched catalog (both via resolveModelVision) →
 * pcmm sidecar (via resolveModelMeta, which reads builtin custom-model metas).
 * Custom (`custom:`) providers have no registry/fetched path, so they skip
 * straight to resolveModelMeta. Fail-closed (`false`) when unknown everywhere —
 * the disabled attach button is a visible UX cue, so we don't fail-open here
 * (unlike the loop's screenshot guard).
 */
export async function resolveSupportsVision(
  provider: ProviderRef,
  model: string,
  fetchedModels?: ModelMeta[],
): Promise<boolean> {
  const registryVision = provider.startsWith("custom:")
    ? undefined
    : resolveModelVision(provider as BuiltinProvider, model, fetchedModels);
  if (registryVision !== undefined) return registryVision;
  const meta = await resolveModelMeta(provider, model);
  return meta?.vision ?? false;
}
