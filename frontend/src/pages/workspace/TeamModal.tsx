import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { projectApi } from '../../api/endpoints';
import { useToast } from '../../components/Toast';
import { Backdrop, ModalShell } from '../../components/Modal';
import { ApiError } from '../../api/client';
import type { ProjectRole } from '../../api/types';

/** Project-scoped roles only — granting workspace access never changes an account's global role. */
const ROLE_OPTIONS: { value: ProjectRole; label: string }[] = [
  { value: 'MEMBER', label: 'Member — read the workspace' },
  { value: 'OWNER', label: 'Owner — edit inputs, decide and approve' },
  { value: 'VIEWER', label: 'Viewer — read only' },
];

export function TeamModal({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('MEMBER');

  const { data } = useQuery({
    queryKey: ['team', projectId],
    queryFn: () => projectApi.members(projectId),
    enabled: open,
  });

  const addMember = useMutation({
    mutationFn: () => projectApi.addMember(projectId, { email: email.trim(), role }),
    onSuccess: (_result, _variables) => {
      queryClient.invalidateQueries({ queryKey: ['team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      notify({ title: 'Member added', detail: `${email.trim()} can now access this project.` });
      setEmail('');
    },
    onError: (error) => notify({ title: 'Could not add member', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => projectApi.removeMember(projectId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['team', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      notify({ title: 'Member removed' });
    },
    onError: (error) => notify({ title: 'Could not remove member', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  return (
    <>
      <Backdrop open={open} onClose={onClose} />
      <ModalShell open={open} className="decision-modal">
        <div className="modal-head">
          <span className="agent-orb">👥</span>
          <div>
            <small>PROJECT ACCESS</small>
            <h2>Manage team</h2>
          </div>
          <button className="close-modal" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="rationale">
          <h3>Who can access this project</h3>
          <p>
            Only the members listed below — plus the program owner — can open this project. Everyone else sees the
            card on the program overview but cannot enter the workspace.
          </p>
        </div>

        <div className="requirement-cards">
          {(data?.members ?? []).map((member) => (
            <div className="req-card" key={member.id}>
              <span>{member.user.initials}</span>
              <div>
                <strong>{member.user.name}</strong>
                <small>
                  {member.user.jobTitle} · {member.role}
                </small>
              </div>
              <button type="button" onClick={() => removeMember.mutate(member.userId)} disabled={removeMember.isPending}>
                Remove
              </button>
            </div>
          ))}
          {data && data.members.length === 0 && <div className="program-empty">No members yet.</div>}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) addMember.mutate();
          }}
        >
          <label>
            Add teammate by email
            <input
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Project role
            <select value={role} onChange={(event) => setRole(event.target.value as ProjectRole)}>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="primary" disabled={addMember.isPending}>
              {addMember.isPending ? 'Adding…' : '+ Add member'}
            </button>
          </div>
        </form>
      </ModalShell>
    </>
  );
}
