import { useQuery } from '@tanstack/react-query';
import { projectApi } from '../api/endpoints';
import { useToast } from '../components/Toast';

/**
 * May the signed-in account change anything on this project?
 *
 * Within a project only `OWNER` writes — `MEMBER` and `VIEWER` are read-only (`PROJECT_WRITE_ROLES`
 * on the server). Every write route enforces that itself, so this is **not** the security boundary:
 * it exists so a reader is shown a read-only screen rather than a form and a row of buttons that
 * answer 403 when touched. Presenting a control that cannot work is its own kind of lie.
 *
 * It reads the workspace query the page has already loaded, so it costs no extra request. While
 * that is still in flight it answers `true`: an owner — the common case — must not watch their own
 * form flicker through a disabled state on every navigation, and a reader who out-races the load
 * gets the server's refusal, which is the same answer a beat later.
 */
export function useProjectWrite(projectId: string): boolean {
  const workspace = useQuery({
    queryKey: ['workspace', projectId],
    queryFn: () => projectApi.workspace(projectId),
  });

  if (!workspace.data) return true;
  // `null` means the server did not report a role. Treat that as read-only: assuming write access
  // from missing information is exactly the wrong default.
  return workspace.data.projectRole === 'OWNER';
}

export const READ_ONLY_TITLE = 'You have view-only access';
export const READ_ONLY_DETAIL = 'Only the project owner can change this project. You can still read and download it.';

/**
 * Freezes a whole screen for a reader, and says so when they try to use it.
 *
 * The plain `disabled` attribute is not enough here for a reason worth remembering: **a disabled
 * button fires no click event**, so it can never explain itself — the reader is left with a grey
 * control and no reason. So `lockClass` makes a control *look* unavailable while it stays
 * clickable, and `guard` swaps its handler for the explanation. `aria-disabled` carries the same
 * fact to a screen reader without removing it from the tab order.
 *
 * `guard` wraps navigation as well as writes, because on these screens moving the selection is
 * itself an invitation to act on it — offering a reader the choice of a different governance model
 * only to refuse the confirm button is a worse experience than not offering it.
 */
export function useReadOnlyGuard(projectId: string) {
  const canWrite = useProjectWrite(projectId);
  const notify = useToast();

  const deny = () => notify({ title: READ_ONLY_TITLE, detail: READ_ONLY_DETAIL });

  function guard<T extends unknown[]>(action: (...args: T) => void): (...args: T) => void {
    return canWrite ? action : () => deny();
  }

  return {
    canWrite,
    guard,
    deny,
    /** Append to a control's className; empty for someone who may write. */
    lockClass: canWrite ? '' : ' is-locked',
    lockedProps: canWrite ? {} : ({ 'aria-disabled': true, title: READ_ONLY_TITLE } as const),
  };
}
