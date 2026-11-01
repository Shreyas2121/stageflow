import type { ParticipantRole } from '@stageflow/shared';

export type StageMembership = {
  role: ParticipantRole;
  onStage: boolean;
};

/** First snapshot is membership, not a later promotion or demotion. */
export type RoleTransition = 'initial' | 'promoted' | 'demoted' | 'unchanged';

export function roleTransition(
  previous: StageMembership | null,
  next: StageMembership,
): RoleTransition {
  if (!previous) return 'initial';
  if (!previous.onStage && next.onStage) return 'promoted';
  if (previous.onStage && !next.onStage) return 'demoted';
  return 'unchanged';
}

/**
 * Device and hand controls follow the joined participant's role.
 * The catalog guess applies only before that snapshot exists.
 */
export function audienceFor(
  role: ParticipantRole | null,
  catalogAttendee: boolean,
): 'attendee' | 'stage' {
  if (role) return role === 'ATTENDEE' ? 'attendee' : 'stage';
  return catalogAttendee ? 'attendee' : 'stage';
}
