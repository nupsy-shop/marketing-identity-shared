// Stub — real implementation fetched during heroku-postbuild

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  attributes?: Record<string, string[]>;
  [key: string]: unknown;
}

export function isKeycloakAdminConfigured(): boolean { return false; }

export function adminFetch(_realm: string, _path: string, _options?: RequestInit): Promise<Response> {
  return Promise.resolve(new Response());
}

export function globalAdminFetch(_path: string, _options?: RequestInit): Promise<Response> {
  return Promise.resolve(new Response());
}

export function createKeycloakUser(_user: Partial<KeycloakUser>): Promise<KeycloakUser> {
  return Promise.resolve({} as KeycloakUser);
}

export function findKeycloakUserByEmail(_realm: string, _email: string): Promise<KeycloakUser | null> {
  return Promise.resolve(null);
}

export function mergeUserAttributes(_userId: string, _attributes: Record<string, string[]>): Promise<void> {
  return Promise.resolve();
}

export function tagSyntheticIdentity(_userId: string, _tag: string): Promise<void> {
  return Promise.resolve();
}

export function verifySamlClient(_realm: string, _config: { spEntityId: string; acsUrl: string }): Promise<{ verified: boolean; reason?: string }> {
  return Promise.resolve({ verified: false });
}

export function sendKeycloakActionsEmail(..._args: unknown[]): Promise<void> {
  return Promise.resolve();
}

export function getKeycloakUser(_realm: string, _userId: string): Promise<KeycloakUser | null> {
  return Promise.resolve(null);
}

export function bulkProvisionUsers(..._args: unknown[]): Promise<KeycloakUser[]> {
  return Promise.resolve([]);
}
