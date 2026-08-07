// Shared SSH connection-input bounds. Keep browser preflight and server boundary
// validation on the same value so an oversized key is rejected before either
// side retains or parses more credential material than the broker accepts.
export const MAX_PRIVATE_KEY_BYTES = 64 * 1024;
