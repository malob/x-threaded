import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConversationResponse } from "../shared/types";
import { resolvePost } from "./api";
import {
  conversationQueryOptions,
  useConversation,
  useConversationWrites,
  useLoadConversation,
  useMarkAllRead,
  useSetRead,
} from "./queries";
import { Inbox } from "./Inbox";
import { Thread } from "./Thread";
import { estimateFetchUsd, formatUsd } from "../shared/pricing";
import { appPath, parsePostPath, xPostUrl } from "../shared/urls";

export function App() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  /** The conversation on screen; its posts live in the query cache, not here. */
  const [rootId, setRootId] = useState<string | null>(null);
  /**
   * Which post the route points at. This is where the reader is, not part of
   * the conversation, so it survives refreshes and resumes on its own instead
   * of being carried through every response.
   */
  const [focusId, setFocusId] = useState<string | null>(null);
  /** Post ID from a deep link whose conversation isn't cached; awaiting consent to fetch. */
  const [pending, setPending] = useState<string | null>(null);
  /** Estimated cost of fetching `pending`, when the post itself is cached. */
  const [pendingCost, setPendingCost] = useState<number | null>(null);
  /** What the last refresh found, tagged with the conversation it looked at. */
  const [newCount, setNewCount] = useState<{ rootId: string; count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Which navigation is the current one.
   *
   * Opening a post is asynchronous, so Back-then-Forward leaves two of them in
   * flight at once. The query cache is keyed by rootId and copes, but this
   * component's `rootId`/`focusId`/history are single-valued: without a way to
   * tell the loser apart, its continuation would still set them and push a URL
   * for the conversation the reader has already left — and fire that
   * conversation's refresh, which is a billable POST nobody asked for. Every
   * navigation takes the next number; a continuation whose number has been
   * superseded applies nothing at all.
   */
  const navigation = useRef(0);

  const conversationQuery = useConversation(rootId);
  const load = useLoadConversation();
  const writes = useConversationWrites({
    onRefreshed: (id, fresh) => setNewCount({ rootId: id, count: fresh.newCount }),
    onError: setError,
  });
  const setRead = useSetRead({ onError: setError });
  const markAllRead = useMarkAllRead({ onError: setError });

  const data = conversationQuery.data;
  const conversation = useMemo(() => (data ? { ...data, focusId } : null), [data, focusId]);

  /** Show a conversation the API just handed us, and put it in the URL. */
  const showLoaded = (response: ConversationResponse, push: boolean) => {
    setRootId(response.rootId);
    setFocusId(response.focusId);
    setPending(null);
    const shownId = response.focusId ?? response.rootId;
    const post = response.posts.find((p) => p.id === shownId);
    const path = appPath(post?.authorHandle, shownId);
    if (push) history.pushState({}, "", path);
    else history.replaceState({}, "", path);
  };

  /**
   * Open the conversation containing a post, focused on it.
   *
   * When it isn't cached, a deep link stops and asks first — the visitor has
   * seen no price. Inbox cards pass `fetchIfMissing` because they display
   * the estimated cost, so the click is already informed consent.
   */
  const openPost = async (postId: string, push = true, fetchIfMissing = false) => {
    const epoch = ++navigation.current;
    setError(null);
    setNewCount(null);
    setPending(null);
    try {
      const { rootId: resolved, replyCount } = await resolvePost(postId);
      if (epoch !== navigation.current) return;
      if (!resolved) {
        if (fetchIfMissing) {
          await fetchConversation(postId, push);
          return;
        }
        setRootId(null);
        setPending(postId);
        setPendingCost(replyCount === null ? null : estimateFetchUsd(replyCount));
        // Route to the post anyway, so reloading returns to this prompt
        // rather than the inbox. The handle is unknown until it's fetched;
        // "i" is the same placeholder x.com uses.
        if (push) history.pushState({}, "", appPath(undefined, postId));
        return;
      }
      // Read the stored conversation now rather than serve the slot's contents:
      // it is free, and a slot filled by an earlier refresh still carries that
      // refresh's cost receipt, which this open did not incur.
      const cached = await queryClient.fetchQuery({
        ...conversationQueryOptions(resolved),
        staleTime: 0,
      });
      if (epoch !== navigation.current) return;
      setRootId(resolved);
      setFocusId(postId === resolved ? null : postId);
      if (push) {
        const post = cached.posts.find((p) => p.id === postId);
        history.pushState({}, "", appPath(post?.authorHandle, postId));
      }
      // The inbox reloads itself whenever it mounts, so leaving a conversation
      // is enough to pick up new read state — no cross-component plumbing.
      writes.refresh(resolved);
    } catch (e) {
      if (epoch !== navigation.current) return;
      setError((e as Error).message);
    }
  };

  /** Fetch a conversation from the API and show it. */
  const fetchConversation = async (postId: string, push = true) => {
    const epoch = ++navigation.current;
    setError(null);
    try {
      const response = await load.mutateAsync(postId);
      if (epoch !== navigation.current) return;
      showLoaded(response, push);
    } catch (e) {
      if (epoch !== navigation.current) return;
      setError((e as Error).message);
    }
  };

  const fetchPending = async () => {
    if (pending) await fetchConversation(pending, false);
  };

  const goHome = (push = true) => {
    // Going home is a navigation too: it has to outrank an open that is still
    // resolving, or that open would drag the reader back into a conversation.
    navigation.current += 1;
    setRootId(null);
    setFocusId(null);
    setNewCount(null);
    setPending(null);
    if (push) history.pushState({}, "", "/");
  };

  useEffect(() => {
    const applyLocation = () => {
      const postId = parsePostPath(location.pathname);
      if (postId) void openPost(postId, false);
      else goHome(false);
    };
    applyLocation();
    window.addEventListener("popstate", applyLocation);
    return () => window.removeEventListener("popstate", applyLocation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!data) {
      document.title = "x-threaded";
      return;
    }
    const root = data.posts.find((p) => p.id === data.rootId);
    const snippet = root ? `@${root.authorHandle}: ${root.text.slice(0, 60)}` : data.rootId;
    document.title = `${snippet} — x-threaded`;
  }, [data]);

  const submitUrl = async () => {
    const epoch = ++navigation.current;
    setError(null);
    setNewCount(null);
    try {
      const response = await load.mutateAsync(url);
      if (epoch !== navigation.current) return;
      showLoaded(response, true);
      if (response.fromCache) writes.refresh(response.rootId);
    } catch (e) {
      if (epoch !== navigation.current) return;
      setError((e as Error).message);
    }
  };

  const loading = load.isPending;
  const errorMessage = error ?? conversationQuery.error?.message ?? null;

  return (
    <main>
      <form
        className="lookup"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void submitUrl();
        }}
      >
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an x.com post URL"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Loading…" : "Load"}
        </button>
        {(conversation || pending) && (
          <button type="button" onClick={() => goHome()}>
            Back
          </button>
        )}
      </form>

      {errorMessage && <div className="error">{errorMessage}</div>}

      {pending ? (
        <div className="load-prompt">
          <p>This conversation isn’t loaded yet.</p>
          <p>
            <button onClick={() => void fetchPending()} disabled={loading}>
              {loading ? "Fetching…" : "Fetch conversation"}
            </button>
            {pendingCost !== null && (
              <span className="post-meta"> {formatUsd(pendingCost)}</span>
            )}
            {"  "}
            <a href={xPostUrl(undefined, pending)} target="_blank" rel="noopener noreferrer">
              view on x.com ↗
            </a>
          </p>
        </div>
      ) : conversation ? (
        <Thread
          key={conversation.rootId}
          conversation={conversation}
          // Per conversation, not per mutation: each control reports on the
          // conversation it belongs to. Whichever writer holds a conversation's
          // lock, both of its buttons are refused until it lets go — the button
          // that isn't labelled with the write in progress stays enabled and
          // its click is a no-op, which is the price of not lying about which
          // operation is running.
          refreshing={writes.isRefreshing(conversation.rootId)}
          resuming={writes.isResuming(conversation.rootId)}
          newCount={newCount?.rootId === conversation.rootId ? newCount.count : null}
          onRefresh={() => writes.refresh(conversation.rootId)}
          onResume={() => writes.resume(conversation.rootId)}
          onSetRead={(ids, read) => setRead.mutate({ rootId: conversation.rootId, ids, read })}
          onMarkAllRead={() => markAllRead.mutate(conversation.rootId)}
        />
      ) : (
        <Inbox onOpenPost={(postId) => void openPost(postId, true, true)} />
      )}
    </main>
  );
}
