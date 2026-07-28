/**
 * @nodo/api-client — thin TypeScript client for the Nodo Public API (`/v1/`).
 *
 * VENDORABLE BY DESIGN: zero runtime dependencies, native fetch/WebCrypto,
 * and the public API types are DUPLICATED here (no `@nodo/types` import) so
 * copying this folder into a consumer repo yields a working client with no
 * extra wiring (regla portable-tooling). Runs in Workers, Pages Functions,
 * Node ≥ 18 and modern browsers (though the API key must NEVER ship to a
 * browser — keep it server-side).
 *
 * Docs: docs/specs/nodo-public-api.md in the nodo-ia repo.
 */

export { NodoClient, NodoApiError } from './client.js'
export type {
  NodoClientOptions,
  ApiSendResponse,
  ApiMessage,
  GetMessagesResponse,
} from './client.js'
export { verifyWebhookSignature } from './webhook.js'
