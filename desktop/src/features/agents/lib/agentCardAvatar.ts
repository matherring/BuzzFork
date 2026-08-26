/**
 * Resolve the avatar for a running agent card.
 *
 * Persisted agent and definition avatars are intentional custom metadata. A
 * runtime/provider kind:0 picture is a truthful fallback only when neither is
 * available; it commonly contains a generic provider logo.
 */
export function resolveAgentCardAvatarUrl(
  agentAvatarUrl: string | null | undefined,
  personaAvatarUrl: string | null | undefined,
  profileAvatarUrl: string | null | undefined,
): string | null {
  for (const candidate of [
    agentAvatarUrl,
    personaAvatarUrl,
    profileAvatarUrl,
  ]) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Profile-dependent actions only wait when persisted custom metadata is not
 * available, preventing a generic provider image from briefly replacing it.
 */
export function isAgentCardAvatarLoading(
  hasLinkedAgent: boolean,
  isProfilePending: boolean,
  hasPersistedAvatar: boolean,
): boolean {
  return hasLinkedAgent && isProfilePending && !hasPersistedAvatar;
}
