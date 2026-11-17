import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { takeInboxClaim } from '../inbox-claim-handoff';

import { errorMessage, inboxApi } from './api';
import { useWorkspace } from './workspace';

// Aramo-Sign-Mobile-Amendment-M-A16-Web-Save-to-Inbox-v1_0 §4 — a signer chose "Save to
// my Aramo inbox" on the web signing page: once signed in, take the handed-off token
// (removed at once), claim it with the existing inbox call (every W2 binding check stays
// on the server) and show Waiting for me. Renders nothing.

export function PendingInboxClaim(): null {
  const { base, toast } = useWorkspace();
  const nav = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const token = takeInboxClaim();
    if (token === null) return;
    inboxApi.claim(token).then(
      () => {
        toast('Added to your inbox');
        nav(`${base}/inbox`);
      },
      (e: unknown) => toast(errorMessage(e, 'That document couldn’t be added to your inbox.')),
    );
  }, [base, nav, toast]);
  return null;
}
