import type { Post } from "../src/shared/types";
import type { FetchedConversation, XApiClient } from "../src/server/xapi";

/** A canned implementation for one method, sync or async. */
type Canned<M extends keyof XApiClient> = (
  ...args: Parameters<XApiClient[M]>
) => Awaited<ReturnType<XApiClient[M]>> | ReturnType<XApiClient[M]>;

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
  ): Promise<Awaited<ReturnType<XApiClient[M]>>> {
    this.calls.push({ method, args });
    if (!canned) {
      throw new Error(`unexpected X API call: ${method}(${describeArg(args[0])})`);
    }
    return await canned(...args);
  }

  getPost(id: string): Promise<Post> {
    return this.record("getPost", this.onGetPost, [id]);
  }

  getPostsByIds(ids: string[]): Promise<Post[]> {
    return this.record("getPostsByIds", this.onGetPostsByIds, [ids]);
  }

  fetchConversation(
    conversationId: string,
    maxPosts: number,
    sinceId?: string,
  ): Promise<FetchedConversation> {
    return this.record("fetchConversation", this.onFetchConversation, [
      conversationId,
      maxPosts,
      sinceId,
    ]);
  }

  getMe(accessToken: string): Promise<{ id: string; username: string; name: string }> {
    return this.record("getMe", this.onGetMe, [accessToken]);
  }

  getOwnPosts(
    accessToken: string,
    userId: string,
    opts: { max?: number; paginationToken?: string } = {},
  ): Promise<{ posts: Post[]; nextToken?: string }> {
    return this.record("getOwnPosts", this.onGetOwnPosts, [accessToken, userId, opts]);
  }

  getBookmarkFolders(
    accessToken: string,
    userId: string,
  ): Promise<{ id: string; name: string }[]> {
    return this.record("getBookmarkFolders", this.onGetBookmarkFolders, [accessToken, userId]);
  }

  getBookmarksByFolder(
    accessToken: string,
    userId: string,
    folderId: string,
    maxPages = 10,
  ): Promise<{ posts: Post[]; ids: string[]; complete: boolean }> {
    return this.record("getBookmarksByFolder", this.onGetBookmarksByFolder, [
      accessToken,
      userId,
      folderId,
      maxPages,
    ]);
  }
}
