import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  conversationKey,
  runConversationLoadWrite,
  runConversationMarkAllRead,
  runConversationReadWrite,
  runConversationResponseWrite,
} from "../src/web/queries/conversation-cache";
import type { ConversationResponse } from "../src/shared/types";
import { makePost } from "./fixtures";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function conversation(
  posts: ConversationResponse["posts"],
  unreadIds = posts.map((post) => post.id),
): ConversationResponse {
  return {
    rootId: posts[0]!.conversationId,
    focusId: null,
    posts,
    quoted: {},
    unreadIds,
    truncated: false,
    fromCache: true,
  };
}

function cached(queryClient: QueryClient, rootId: string): ConversationResponse {
  const value = queryClient.getQueryData<ConversationResponse>(conversationKey(rootId));
  if (!value) throw new Error("conversation missing from cache");
  return value;
}

describe("conversation cache response ownership", () => {
  it("does not let an older same-root GET overwrite a newer writer", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const stale = conversation([root]);
    const fresh = conversation([root, reply]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let resolveStale!: (value: ConversationResponse) => void;
    const pending = queryClient
      .fetchQuery({
        queryKey: conversationKey(root.id),
        queryFn: () =>
          new Promise<ConversationResponse>((resolve) => {
            resolveStale = resolve;
          }),
      })
      .catch(() => undefined);
    await Promise.resolve();

    await runConversationResponseWrite(queryClient, root.id, async () => fresh);
    resolveStale(stale);
    await pending;

    expect(
      queryClient.getQueryData<ConversationResponse>(conversationKey(root.id)),
    ).toEqual(fresh);
  });

  it("keeps the latest targeted intent when an older conflicting write fails", async () => {
    const root = makePost();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const first = deferred<void>();
    const second = deferred<void>();
    const firstStarted = deferred<void>();
    const requests: string[] = [];

    const read = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      () => {
        requests.push("read");
        firstStarted.resolve();
        return first.promise;
      },
    );
    const unread = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: false },
      () => {
        requests.push("unread");
        return second.promise;
      },
    );

    // Both intentions render immediately, but only the first request is sent.
    expect(cached(queryClient, root.id).unreadIds).toEqual([root.id]);
    await firstStarted.promise;
    expect(requests).toEqual(["read"]);

    // The newer transport is ready first; FIFO ownership still withholds it.
    second.resolve();
    expect(requests).toEqual(["read"]);
    const failed = read.then(
      () => undefined,
      (error: unknown) => error,
    );
    first.reject(new Error("older write failed"));
    expect(await failed).toEqual(new Error("older write failed"));

    // Removing the failed older intent cannot remove the newer optimistic one.
    expect(cached(queryClient, root.id).unreadIds).toEqual([root.id]);
    await unread;
    expect(requests).toEqual(["read", "unread"]);
    expect(cached(queryClient, root.id).unreadIds).toEqual([root.id]);
  });

  it("serializes mark-all before a newer targeted override", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root, reply]));
    const markAllRequest = deferred<void>();
    const unreadRequest = deferred<void>();
    const markAllStarted = deferred<void>();
    const requests: string[] = [];
    let markedIds: readonly string[] = [];

    const markAll = runConversationMarkAllRead(
      queryClient,
      root.id,
      (ids) => {
        markedIds = ids;
        requests.push("mark-all");
        markAllStarted.resolve();
        return markAllRequest.promise;
      },
    );
    const unreadRoot = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: false },
      () => {
        requests.push("unread-root");
        return unreadRequest.promise;
      },
    );

    expect(cached(queryClient, root.id).unreadIds).toEqual([root.id]);
    await markAllStarted.promise;
    expect(requests).toEqual(["mark-all"]);
    unreadRequest.resolve();
    markAllRequest.resolve();
    await markAll;
    await unreadRoot;

    expect(requests).toEqual(["mark-all", "unread-root"]);
    expect(markedIds).toEqual([root.id, reply.id]);
    expect(cached(queryClient, root.id).unreadIds).toEqual([root.id]);
  });

  it("does not let mark-all consume a post introduced by a later response", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const markRequest = deferred<void>();
    const markStarted = deferred<void>();
    let markedIds: readonly string[] = [];

    const mark = runConversationMarkAllRead(
      queryClient,
      root.id,
      (ids) => {
        markedIds = ids;
        markStarted.resolve();
        return markRequest.promise;
      },
    );
    const refresh = runConversationResponseWrite(queryClient, root.id, async () =>
      conversation([root, reply]),
    );

    await markStarted.promise;
    markRequest.resolve();
    await mark;
    await refresh;

    expect(markedIds).toEqual([root.id]);
    expect(cached(queryClient, root.id).unreadIds).toEqual([reply.id]);
  });

  it("applies refresh-before-mark-all to every post the earlier response introduced", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const refreshResponse = deferred<ConversationResponse>();
    const refreshStarted = deferred<void>();
    const markStarted = deferred<void>();
    const requests: string[] = [];
    let markedIds: readonly string[] = [];

    const refresh = runConversationResponseWrite(queryClient, root.id, () => {
      requests.push("refresh");
      refreshStarted.resolve();
      return refreshResponse.promise;
    });
    const mark = runConversationMarkAllRead(
      queryClient,
      root.id,
      async (ids) => {
        markedIds = ids;
        requests.push("mark-all");
        markStarted.resolve();
      },
    );

    await refreshStarted.promise;
    expect(requests).toEqual(["refresh"]);
    refreshResponse.resolve(conversation([root, reply]));
    await refresh;
    await markStarted.promise;
    await mark;

    expect(requests).toEqual(["refresh", "mark-all"]);
    expect(markedIds).toEqual([root.id, reply.id]);
    expect(cached(queryClient, root.id).unreadIds).toEqual([]);
  });

  it("replays applied and pending read intent over a paid conversation response", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const freshReply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root, reply]));
    const rootRequest = deferred<void>();
    const replyRequest = deferred<void>();

    const readRoot = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      () => rootRequest.promise,
    );
    const readReply = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [reply.id], read: true },
      () => replyRequest.promise,
    );
    expect(cached(queryClient, root.id).unreadIds).toEqual([]);

    // The first write is applied, while the second stays pending.
    rootRequest.resolve();
    await readRoot;
    const paid = {
      ...conversation([root, reply, freshReply]),
      cost: { posts: 3, billable: 3, usd: 0.015 },
    };
    await runConversationLoadWrite(queryClient, null, async () => paid);

    // The response contributes its new post, but cannot restore the two ids
    // covered by the applied/pending local intentions.
    expect(cached(queryClient, root.id).posts).toHaveLength(3);
    expect(cached(queryClient, root.id).unreadIds).toEqual([freshReply.id]);

    replyRequest.resolve();
    await readReply;
    expect(cached(queryClient, root.id).unreadIds).toEqual([freshReply.id]);
  });

  it("runs a paid writer before a later read while showing the read intent immediately", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const paidResponse = deferred<ConversationResponse>();
    const readResponse = deferred<void>();
    const paidStarted = deferred<void>();
    const readStarted = deferred<void>();
    const requests: string[] = [];

    const paid = runConversationResponseWrite(queryClient, root.id, () => {
      requests.push("paid");
      paidStarted.resolve();
      return paidResponse.promise;
    });
    const read = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      () => {
        requests.push("read");
        readStarted.resolve();
        return readResponse.promise;
      },
    );

    // The later intent is visible without sending its request out of order.
    expect(cached(queryClient, root.id).unreadIds).toEqual([]);
    await paidStarted.promise;
    expect(requests).toEqual(["paid"]);

    // Even a response whose read snapshot is stale cannot erase the pending
    // intent. Its new post is retained and remains unread.
    paidResponse.resolve(conversation([root, reply]));
    await paid;
    expect(cached(queryClient, root.id).posts).toHaveLength(2);
    expect(cached(queryClient, root.id).unreadIds).toEqual([reply.id]);

    await readStarted.promise;
    readResponse.resolve();
    await read;
    expect(requests).toEqual(["paid", "read"]);
    expect(cached(queryClient, root.id).unreadIds).toEqual([reply.id]);
  });

  it("keeps a successful read over a later stale paid commit after the read drains", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const readResponse = deferred<void>();
    const paidResponse = deferred<ConversationResponse>();
    const readStarted = deferred<void>();
    const paidStarted = deferred<void>();
    const requests: string[] = [];

    const read = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      () => {
        requests.push("read");
        readStarted.resolve();
        return readResponse.promise;
      },
    );
    const paid = runConversationResponseWrite(queryClient, root.id, () => {
      requests.push("paid");
      paidStarted.resolve();
      return paidResponse.promise;
    });

    await readStarted.promise;
    expect(requests).toEqual(["read"]);
    readResponse.resolve();
    await read;
    await paidStarted.promise;

    // The read request has fully settled, but its successful intent remains
    // owned until the already-enqueued writer commits and the batch drains.
    paidResponse.resolve(conversation([root, reply]));
    await paid;
    expect(requests).toEqual(["read", "paid"]);
    expect(cached(queryClient, root.id).posts).toHaveLength(2);
    expect(cached(queryClient, root.id).unreadIds).toEqual([reply.id]);
  });

  it("orders a root-unknown same-root load before a later read and commits it under ownership", async () => {
    const root = makePost();
    const reply = makePost({ conversationId: root.id, parentId: root.id });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const loadResponse = deferred<ConversationResponse>();
    const readResponse = deferred<void>();
    const loadStarted = deferred<void>();
    const readStarted = deferred<void>();
    const requests: string[] = [];

    const load = runConversationLoadWrite(queryClient, root.id, () => {
      requests.push("load");
      loadStarted.resolve();
      return loadResponse.promise;
    });
    const read = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      () => {
        requests.push("read");
        readStarted.resolve();
        return readResponse.promise;
      },
    );

    expect(cached(queryClient, root.id).unreadIds).toEqual([]);
    await loadStarted.promise;
    expect(requests).toEqual(["load"]);

    // A response with a stale read snapshot commits before the later read
    // request is sent, while the pending intent stays rendered over it.
    loadResponse.resolve(conversation([root, reply]));
    await load;
    expect(cached(queryClient, root.id).unreadIds).toEqual([reply.id]);
    await readStarted.promise;

    readResponse.resolve();
    await read;
    expect(requests).toEqual(["load", "read"]);
    expect(cached(queryClient, root.id).posts).toHaveLength(2);
    expect(cached(queryClient, root.id).unreadIds).toEqual([reply.id]);
  });

  it("caches an owner-serialized load under the root it actually returns", async () => {
    const owner = makePost();
    const loaded = makePost();
    const ownerConversation = conversation([owner], []);
    const loadedConversation = conversation([loaded]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(owner.id), ownerConversation);

    await runConversationLoadWrite(queryClient, owner.id, async () => loadedConversation);

    expect(cached(queryClient, owner.id)).toEqual(ownerConversation);
    expect(cached(queryClient, loaded.id)).toEqual(loadedConversation);
  });

  it("keeps a newer unknown-target payload over an older known response that lands later", async () => {
    const owner = makePost();
    const target = makePost();
    const oldReply = makePost({ conversationId: target.id, parentId: target.id });
    const newReply = makePost({ conversationId: target.id, parentId: target.id });
    const quoted = makePost();
    const oldPayload = { ...conversation([target, oldReply]), quoted: {}, truncated: true };
    const newPayload = {
      ...conversation([target, newReply]),
      quoted: { [quoted.id]: quoted },
      truncated: false,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(owner.id), conversation([owner], []));
    queryClient.setQueryData(conversationKey(target.id), conversation([target]));
    const knownResponse = deferred<ConversationResponse>();
    const knownStarted = deferred<void>();
    const unknownStarted = deferred<void>();
    const reconciledRoots: string[] = [];

    const known = runConversationResponseWrite(queryClient, target.id, () => {
      knownStarted.resolve();
      return knownResponse.promise;
    });
    await knownStarted.promise;

    // This load was invoked later, but its destination was unknowable until
    // the response arrived. It must still become B's newest response owner.
    const unknown = runConversationLoadWrite(
      queryClient,
      owner.id,
      async () => {
        unknownStarted.resolve();
        return newPayload;
      },
      async (rootId) => {
        reconciledRoots.push(rootId);
        return newPayload;
      },
    );
    await unknownStarted.promise;
    expect(reconciledRoots).toEqual([]);
    knownResponse.resolve(oldPayload);
    await Promise.all([known, unknown]);

    const final = cached(queryClient, target.id);
    expect(reconciledRoots).toEqual([target.id]);
    expect(final.posts).toEqual(newPayload.posts);
    expect(final.truncated).toBe(false);
    expect(final.quoted).toEqual(newPayload.quoted);
  });

  it("reconciles a later cached load after an in-flight refresh produces the fresher superset", async () => {
    const target = makePost();
    const reply = makePost({ conversationId: target.id, parentId: target.id });
    const quoted = makePost();
    const receipt = { posts: 1, billable: 1, usd: 0.005 };
    const staleCached = {
      ...conversation([target]),
      truncated: true,
      cost: receipt,
    };
    const refreshed = {
      ...conversation([target, reply]),
      quoted: { [quoted.id]: quoted },
      truncated: false,
      fromCache: false,
    };
    const authoritative = { ...refreshed, fromCache: true };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(target.id), conversation([target]));
    const refreshResponse = deferred<ConversationResponse>();
    const refreshStarted = deferred<void>();
    const loadStarted = deferred<void>();
    const reconciledRoots: string[] = [];

    const refresh = runConversationResponseWrite(
      queryClient,
      target.id,
      () => {
        refreshStarted.resolve();
        return refreshResponse.promise;
      },
      { coversRefresh: true },
    );
    await refreshStarted.promise;

    const load = runConversationLoadWrite(
      queryClient,
      null,
      async () => {
        loadStarted.resolve();
        return staleCached;
      },
      async (rootId) => {
        reconciledRoots.push(rootId);
        return authoritative;
      },
    );
    await loadStarted.promise;
    expect(reconciledRoots).toEqual([]);

    refreshResponse.resolve(refreshed);
    const [, loaded] = await Promise.all([refresh, load]);

    const final = cached(queryClient, target.id);
    expect(reconciledRoots).toEqual([target.id]);
    expect(final.posts).toEqual(authoritative.posts);
    expect(final.quoted).toEqual(authoritative.quoted);
    expect(final.truncated).toBe(false);
    expect(final.cost).toEqual(receipt);
    expect(loaded.refreshCovered).toBe(true);
  });

  it("does not cover the automatic refresh when an overlapping refresh fails", async () => {
    const target = makePost();
    const cachedResponse = { ...conversation([target]), truncated: true };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(target.id), cachedResponse);
    const refreshResponse = deferred<ConversationResponse>();
    const refreshStarted = deferred<void>();

    const refresh = runConversationResponseWrite(
      queryClient,
      target.id,
      () => {
        refreshStarted.resolve();
        return refreshResponse.promise;
      },
      { coversRefresh: true },
    );
    await refreshStarted.promise;
    const load = runConversationLoadWrite(
      queryClient,
      null,
      async () => cachedResponse,
      async () => cachedResponse,
    );

    const failedRefresh = refresh.then(
      () => undefined,
      (error: unknown) => error,
    );
    refreshResponse.reject(new Error("refresh failed"));
    expect(await failedRefresh).toEqual(new Error("refresh failed"));
    const loaded = await load;

    expect(loaded.refreshCovered).toBeUndefined();
  });

  it("does not treat a successful resume or free read as newest-post refresh coverage", async () => {
    const target = makePost();
    const cachedResponse = conversation([target]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const response = deferred<ConversationResponse>();
    const responseStarted = deferred<void>();

    const nonRefresh = runConversationResponseWrite(queryClient, target.id, () => {
      responseStarted.resolve();
      return response.promise;
    });
    await responseStarted.promise;
    const load = runConversationLoadWrite(
      queryClient,
      null,
      async () => cachedResponse,
      async () => cachedResponse,
    );

    response.resolve(cachedResponse);
    await nonRefresh;
    const loaded = await load;

    expect(loaded.refreshCovered).toBeUndefined();
  });

  it("reconciles an authoritative older unknown load after a newer partial unknown load commits", async () => {
    const target = makePost();
    const reply = makePost({ conversationId: target.id, parentId: target.id });
    const quoted = makePost();
    const partial = { ...conversation([target]), truncated: true };
    const authoritative = {
      ...conversation([target, reply]),
      quoted: { [quoted.id]: quoted },
      truncated: false,
      fromCache: false,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstResponse = deferred<ConversationResponse>();
    const firstStarted = deferred<void>();
    const reconciledRoots: string[] = [];

    // U1 starts the authoritative fetch first. U2 is invoked later but sees a
    // partial cached row and completes first, so it owns the higher invocation
    // id even though its payload is older.
    const first = runConversationLoadWrite(
      queryClient,
      null,
      () => {
        firstStarted.resolve();
        return firstResponse.promise;
      },
      async (rootId) => {
        reconciledRoots.push(rootId);
        return authoritative;
      },
    );
    await firstStarted.promise;
    await runConversationLoadWrite(queryClient, null, async () => partial, async (rootId) => {
      reconciledRoots.push(rootId);
      // U1 has not completed its server write yet, so the free snapshot is
      // still partial. U1's later reconciliation must be the final authority.
      return partial;
    });
    expect(cached(queryClient, target.id).truncated).toBe(true);

    firstResponse.resolve(authoritative);
    await first;

    const final = cached(queryClient, target.id);
    expect(reconciledRoots).toEqual([target.id, target.id]);
    expect(final.posts).toEqual(authoritative.posts);
    expect(final.quoted).toEqual(authoritative.quoted);
    expect(final.truncated).toBe(false);
  });

  it("fails open with the paid response and receipt when destination reconciliation fails", async () => {
    const target = makePost();
    const reply = makePost({ conversationId: target.id, parentId: target.id });
    const receipt = { posts: 2, billable: 2, usd: 0.01 };
    const stale = { ...conversation([target]), truncated: true };
    const paid = {
      ...conversation([target, reply]),
      truncated: false,
      fromCache: false,
      cost: receipt,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const knownResponse = deferred<ConversationResponse>();
    const knownStarted = deferred<void>();

    const known = runConversationResponseWrite(queryClient, target.id, () => {
      knownStarted.resolve();
      return knownResponse.promise;
    });
    await knownStarted.promise;
    const load = runConversationLoadWrite(
      queryClient,
      null,
      async () => paid,
      async () => {
        throw new Error("free reconciliation failed");
      },
    );

    knownResponse.resolve(stale);
    await known;
    const loaded = await load;

    expect(loaded).toEqual(paid);
    expect(cached(queryClient, target.id).posts).toEqual(paid.posts);
    expect(cached(queryClient, target.id).truncated).toBe(false);
    expect(cached(queryClient, target.id).cost).toEqual(receipt);
  });

  it("keeps a newer destination payload while attaching a paid receipt on reconcile failure", async () => {
    const owner = makePost();
    const target = makePost();
    const oldReply = makePost({ conversationId: target.id, parentId: target.id });
    const newReply = makePost({ conversationId: target.id, parentId: target.id });
    const quoted = makePost();
    const receipt = { posts: 2, billable: 2, usd: 0.01 };
    const paid = {
      ...conversation([target, oldReply]),
      truncated: true,
      fromCache: false,
      cost: receipt,
    };
    const newer = {
      ...conversation([target, newReply]),
      quoted: { [quoted.id]: quoted },
      truncated: false,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(owner.id), conversation([owner]));
    const paidResponse = deferred<ConversationResponse>();
    const paidStarted = deferred<void>();

    const load = runConversationLoadWrite(
      queryClient,
      owner.id,
      () => {
        paidStarted.resolve();
        return paidResponse.promise;
      },
      async () => {
        throw new Error("free reconciliation failed");
      },
    );
    await paidStarted.promise;
    await runConversationResponseWrite(queryClient, target.id, async () => newer);
    paidResponse.resolve(paid);
    const loaded = await load;

    expect(loaded).toEqual(paid);
    const final = cached(queryClient, target.id);
    expect(final.posts).toEqual(newer.posts);
    expect(final.quoted).toEqual(newer.quoted);
    expect(final.truncated).toBe(false);
    expect(final.cost).toEqual(receipt);
  });

  it("keeps a newer known payload over an older unknown-target response", async () => {
    const owner = makePost();
    const target = makePost();
    const oldReply = makePost({ conversationId: target.id, parentId: target.id });
    const newReply = makePost({ conversationId: target.id, parentId: target.id });
    const quoted = makePost();
    const oldPayload = { ...conversation([target, oldReply]), quoted: {}, truncated: true };
    const newPayload = {
      ...conversation([target, newReply]),
      quoted: { [quoted.id]: quoted },
      truncated: false,
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(owner.id), conversation([owner], []));
    queryClient.setQueryData(conversationKey(target.id), conversation([target]));
    const unknownResponse = deferred<ConversationResponse>();
    const unknownStarted = deferred<void>();
    const reconciledRoots: string[] = [];

    const unknown = runConversationLoadWrite(
      queryClient,
      owner.id,
      () => {
        unknownStarted.resolve();
        return unknownResponse.promise;
      },
      async (rootId) => {
        reconciledRoots.push(rootId);
        return newPayload;
      },
    );
    await unknownStarted.promise;

    await runConversationResponseWrite(queryClient, target.id, async () => newPayload);
    unknownResponse.resolve(oldPayload);
    await unknown;

    expect(cached(queryClient, target.id)).toEqual(newPayload);
    expect(reconciledRoots).toEqual([target.id]);
  });

  it("keeps a target read when an older different-root load lands after it drains", async () => {
    const owner = makePost();
    const target = makePost();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(owner.id), conversation([owner], []));
    queryClient.setQueryData(conversationKey(target.id), conversation([target]));
    const loadResponse = deferred<ConversationResponse>();

    const load = runConversationLoadWrite(queryClient, owner.id, () => loadResponse.promise);
    const read = runConversationReadWrite(
      queryClient,
      target.id,
      { kind: "set", ids: [target.id], read: true },
      async () => undefined,
    );

    await read;
    loadResponse.resolve(conversation([target]));
    await load;

    expect(cached(queryClient, target.id).unreadIds).toEqual([]);
  });

  it("keeps a target read when an older unowned load lands after it drains", async () => {
    const target = makePost();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(target.id), conversation([target]));
    const loadResponse = deferred<ConversationResponse>();

    const load = runConversationLoadWrite(queryClient, null, () => loadResponse.promise);
    const read = runConversationReadWrite(
      queryClient,
      target.id,
      { kind: "set", ids: [target.id], read: true },
      async () => undefined,
    );

    await read;
    loadResponse.resolve(conversation([target]));
    await load;

    expect(cached(queryClient, target.id).unreadIds).toEqual([]);
  });

  it("releases an unknown response's read protection when that response fails", async () => {
    const root = makePost();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const loadResponse = deferred<ConversationResponse>();

    const load = runConversationLoadWrite(queryClient, null, () => loadResponse.promise);
    await runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      async () => undefined,
    );

    const failed = load.then(
      () => undefined,
      (error: unknown) => error,
    );
    loadResponse.reject(new Error("load failed"));
    expect(await failed).toEqual(new Error("load failed"));

    // A later authoritative response did not overlap that read. If the failed
    // load's protection leaked, it would incorrectly keep replaying forever.
    await runConversationLoadWrite(queryClient, null, async () => conversation([root]));
    expect(cached(queryClient, root.id).unreadIds).toEqual([root.id]);
  });

  it("queues a free stored response behind an earlier read", async () => {
    const root = makePost();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(conversationKey(root.id), conversation([root]));
    const readResponse = deferred<void>();
    const storedResponse = deferred<ConversationResponse>();
    const storedStarted = deferred<void>();

    const read = runConversationReadWrite(
      queryClient,
      root.id,
      { kind: "set", ids: [root.id], read: true },
      () => readResponse.promise,
    );
    const stored = runConversationResponseWrite(queryClient, root.id, () => {
      storedStarted.resolve();
      return storedResponse.promise;
    });

    // The free read is a response writer too; it cannot start outside the
    // root queue and later restore the stale unread snapshot.
    readResponse.resolve();
    await read;
    await storedStarted.promise;
    storedResponse.resolve(conversation([root]));
    await stored;

    expect(cached(queryClient, root.id).unreadIds).toEqual([]);
  });

  it("keeps App and query observers off direct TanStack conversation fetches", async () => {
    const app = await Bun.file(new URL("../src/web/App.tsx", import.meta.url)).text();
    const queries = await Bun.file(
      new URL("../src/web/queries/conversation.ts", import.meta.url),
    ).text();

    expect(app).toContain("fetchStoredConversation(queryClient, resolved)");
    expect(app).toContain("response.fromCache && !response.refreshCovered");
    expect(app).not.toContain("queryClient.fetchQuery");
    expect(queries).toContain("queryFn: skipToken");
    expect(queries.match(/coversRefresh: true/g)).toHaveLength(1);
  });
});
