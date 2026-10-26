import {
  getAliases,
  getEntityAndConceptPageTitles,
  getExtractionsBySession,
  rebuildSessionMentions,
} from '../../lib/db';
import { buildMentionPin, type ResolverGroup } from '../../lib/mention-pin';
import { sessionMentionRows } from '../../lib/mention-rows';

/** What /api/compile/resolve does last: rebuild the session's mention rows through these groups. */
export function rebuildMentionsLikeResolve(sessionId: string, groups: ResolverGroup[] = []): number {
  return rebuildSessionMentions(
    sessionId,
    sessionMentionRows(
      getExtractionsBySession(sessionId),
      groups,
      buildMentionPin(getEntityAndConceptPageTitles(), getAliases())
    )
  );
}
