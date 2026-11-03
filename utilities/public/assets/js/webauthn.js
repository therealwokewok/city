// Small bridge between the browser's passkey API and our server. JSON in, JSON out.
const toBuf = (b64url) => {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const bin = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
};
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials);

export async function createPasskey(options) {
  const cred = await navigator.credentials.create({
    publicKey: {
      ...options, challenge: toBuf(options.challenge), user: { ...options.user, id: toBuf(options.user.id) },
      excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
    },
  });
  return {
    id: cred.id, rawId: toB64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment || undefined,
    response: {
      clientDataJSON: toB64(cred.response.clientDataJSON), attestationObject: toB64(cred.response.attestationObject),
      transports: cred.response.getTransports ? cred.response.getTransports() : [],
    },
  };
}

export async function usePasskey(options) {
  const cred = await navigator.credentials.get({
    publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })) },
  });
  return {
    id: cred.id, rawId: toB64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64(cred.response.clientDataJSON), authenticatorData: toB64(cred.response.authenticatorData),
      signature: toB64(cred.response.signature), userHandle: cred.response.userHandle ? toB64(cred.response.userHandle) : undefined,
    },
  };
}
