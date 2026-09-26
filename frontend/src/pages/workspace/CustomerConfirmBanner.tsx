import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { inputApi } from '../../api/endpoints';
import type { CustomerSuggestion } from '../../api/types';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../api/client';

/**
 * "The documents say this project is for X — is that right?"
 *
 * The customer field is what the whole reference library keys off: it decides which checklist the
 * project is scored against and whose template its kickoff deck fills. Getting it wrong is
 * expensive and quiet, so extraction is only ever allowed to *propose* it, and this is where a
 * person decides.
 *
 * Three things are deliberately in view before the PM can accept:
 *   - the quote the name came from, and which file, so the claim can be judged without opening it;
 *   - whether the name resolves to a customer the library already knows — because a name that
 *     resolves to nothing will not unlock any checklist or template, and the PM should see that
 *     before wondering why nothing happened;
 *   - an editable field, since "LG CNS Vietnam" in a document may need to be typed as "LG CNS".
 */
export function CustomerConfirmBanner({
  projectId,
  suggestion,
}: {
  projectId: string;
  suggestion: CustomerSuggestion | null;
}) {
  const notify = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(suggestion?.name ?? '');

  // A fresh Verify can replace the suggestion while this is on screen.
  useEffect(() => setValue(suggestion?.name ?? ''), [suggestion?.name, suggestion?.suggestedAt]);

  const resolve = useMutation({
    mutationFn: ({ action, name }: { action: 'accept' | 'dismiss'; name?: string }) =>
      inputApi.resolveCustomerSuggestion(projectId, action, name),
    onSuccess: (result, variables) => {
      // The customer drives readiness, the studio catalog and the dashboard — refresh all of it.
      queryClient.invalidateQueries({ queryKey: ['input', projectId] });
      queryClient.invalidateQueries({ queryKey: ['workspace', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['studio', projectId] });
      queryClient.invalidateQueries({ queryKey: ['checklist', projectId] });
      notify(
        variables.action === 'accept'
          ? {
              title: `Customer set to ${result.customer}`,
              detail: 'Their checklist and document templates now apply to this project.',
            }
          : { title: 'Suggestion dismissed', detail: 'The customer field is unchanged.' },
      );
    },
    onError: (error) =>
      notify({ title: 'Could not save', detail: error instanceof ApiError ? error.message : 'Unexpected error' }),
  });

  if (!suggestion) return null;

  return (
    <section className="customer-confirm">
      <div className="customer-confirm-head">
        <span className="customer-confirm-glyph">✦</span>
        <div>
          <strong>Is this project for {suggestion.name}?</strong>
          <p>
            Read from {suggestion.sourceLabel ? <b>{suggestion.sourceLabel}</b> : 'an uploaded document'}.{' '}
            {/*
              A proposal that would overwrite something must say so. The Customer field being
              already filled — with a business-unit name that matches no customer, typically — is
              the common case, not the exception.
            */}
            {suggestion.replaces ? (
              <>
                The Customer field currently reads <b>{suggestion.replaces}</b>, which matches no customer in the
                library. Confirming replaces it.
              </>
            ) : (
              <>
                Nothing has been changed — confirm it and this customer’s checklist and templates start applying to
                the project.
              </>
            )}
          </p>
        </div>
      </div>

      <blockquote className="customer-confirm-evidence">“{suggestion.evidence}”</blockquote>

      <p className={`customer-confirm-match${suggestion.matchedKey ? '' : ' unknown'}`}>
        {suggestion.matchedKey ? (
          <>
            Matches the <b>{suggestion.matchedName}</b> account library — its checklist and templates are ready.
          </>
        ) : (
          <>
            No account library matches this name yet, so confirming it will not unlock a checklist or a template. Add
            one in Account Libraries, or add this spelling as an alias of an existing library.
          </>
        )}
      </p>

      <div className="customer-confirm-actions">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Customer name"
          placeholder="Customer name"
        />
        <button
          className="primary"
          disabled={resolve.isPending || !value.trim()}
          onClick={() => resolve.mutate({ action: 'accept', name: value.trim() })}
        >
          {resolve.isPending ? 'Saving…' : 'Confirm customer'}
        </button>
        <button className="secondary" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: 'dismiss' })}>
          Not this
        </button>
      </div>
    </section>
  );
}
