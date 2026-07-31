import { NO_READS, addReceipts, ownedReads, postReads, type Receipt } from "../src/shared/pricing";
import type { Post } from "../src/shared/types";
import type { Billed, FetchedConversation, XApiClient } from "../src/server/xapi";

/** What a canned method hands back: the payload, without the receipt. */
type Payload<M extends keyof XApiClient> =
  Awaited<ReturnType<XApiClient[M]>> extends Billed<infer T> ? T : never;

/** A canned implementation for one method, sync or async. */
type Canned<M extends keyof XApiClient> = (
  ...args: Parameters<XApiClient[M]>
) => Payload<M> | Promise<Payload<M>>;

/**
 * What one /tweets/search/all response bills: each distinct post it returned,
 * once — results and includes alike. Shared with the tests that drive `ingest`
 * directly, so there is one statement of the rule.
 */
export function searchReceipt({ posts, referenced }: FetchedConversation): Receipt {
  return postReads(new Set([...posts, ...referenced].map((p) => p.id)).size);
}

function describeArg(arg: unknown): string {
  if (arg === undefined) return "";
  if (typeof arg === "string") return arg;
  if (Array.isArray(arg)) return `[${arg.length} items]`;
  return String(arg);
}

/**
 * X API double whose every method throws unless a test cans it, and which
 * counts every call. Reads bill per post, so an unplanned call is a bug worth
 * failing on, and "this route made zero calls" is the assertion that keeps
 * cache guards honest.
 *
 * Tests can the payload; the receipt is this double's job, priced the way the
 * real client prices the same endpoint. A route that forgets to charge one
 * then fails here rather than in the fixture.
 */
export class FakeXApi implements XApiClient {
  readonly calls: { method: string; args: unknown[] }[] = [];

  onGetPost?: Canned<"getPost">;
  onGetPostsByIds?: Canned<"getPostsByIds">;
  onFetchConversation?: Canned<"fetchConversation">;
  onGetMe?: Canned<"getMe">;
  onGetOwnPosts?: Canned<"getOwnPosts">;
  onGetBookmarkFolders?: Canned<"getBookmarkFolders">;
  onGetBookmarksByFolder?: Canned<"getBookmarksByFolder">;

  /** How many times a method was called, canned or not. */
  count(method: keyof XApiClient): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  private async record<M extends keyof XApiClient>(
    method: M,
    canned: Canned<M> | undefined,
    args: Parameters<XApiClient[M]>,
    price: (payload: Payload<M>) => Receipt,
  ): Promise<Billed<Payload<M>>> {
    this.calls.push({ method, args });
    if (!canned) {
      throw new Error(`unexpected X API call: ${method}(${describeArg(args[0])})`);
    }
    const value = await canned(...args);
    return { value, receipt: price(value) };
  }

  getPost(id: string): Promise<Billed<Post>> {
    return this.record("getPost", this.onGetPost, [id], () => postReads(1));
  }

  getPostsByIds(ids: string[]): Promise<Billed<Post[]>> {
    return this.record("getPostsByIds", this.onGetPostsByIds, [ids], (posts) =>
      postReads(posts.length),
    );
  }

  fetchConversation(
    conversationId: string,
    maxPosts: number,
    sinceId?: string,
  ): Promise<Billed<FetchedConversation>> {
    return this.record(
      "fetchConversation",
      this.onFetchConversation,
      [conversationId, maxPosts, sinceId],
      // One canned result stands for one search response, so a post in both
      // the results and the includes is the one read the real client counts.
      searchReceipt,
    );
  }

  getMe(accessToken: string): Promise<Billed<{ id: string; username: string; name: string }>> {
    return this.record("getMe", this.onGetMe, [accessToken], () => postReads(1));
  }

  getOwnPosts(
    accessToken: string,
    userId: string,
    opts: { max?: number; paginationToken?: string } = {},
  ): Promise<Billed<{ posts: Post[]; nextToken?: string }>> {
    return this.record(
      "getOwnPosts",
      this.onGetOwnPosts,
      [accessToken, userId, opts],
      ({ posts }) => ownedReads(posts.length),
    );
  }

  getBookmarkFolders(
    accessToken: string,
    userId: string,
  ): Promise<Billed<{ id: string; name: string }[]>> {
    return this.record(
      "getBookmarkFolders",
      this.onGetBookmarkFolders,
      [accessToken, userId],
      () => NO_READS,
    );
  }

  getBookmarksByFolder(
    accessToken: string,
    userId: string,
    folderId: string,
    maxPages = 10,
  ): Promise<Billed<{ posts: Post[]; ids: string[]; complete: boolean }>> {
    return this.record(
      "getBookmarksByFolder",
      this.onGetBookmarksByFolder,
      [accessToken, userId, folderId, maxPages],
      // Owned Reads for the stubs the folder pages enumerate, lookups for the
      // posts hydrating them returned — the nesting the real client bills.
      ({ posts, ids }) => addReceipts(ownedReads(ids.length), postReads(posts.length)),
    );
  }
}
