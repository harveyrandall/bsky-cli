import { vi } from "vitest";

export function createMockAgent() {
  const agent = {
    session: { did: "did:plc:test123", handle: "test.bsky.social" },
    login: vi.fn(),
    resumeSession: vi.fn(),
    post: vi.fn(),
    like: vi.fn(),
    repost: vi.fn(),
    follow: vi.fn(),
    deleteFollow: vi.fn(),
    mute: vi.fn(),
    getProfile: vi.fn(),
    getTimeline: vi.fn(),
    getAuthorFeed: vi.fn(),
    getPostThread: vi.fn(),
    getFollows: vi.fn(),
    getFollowers: vi.fn(),
    getLikes: vi.fn(),
    getRepostedBy: vi.fn(),
    listNotifications: vi.fn(),
    searchActors: vi.fn(),
    uploadBlob: vi.fn(),
    com: {
      atproto: {
        repo: {
          getRecord: vi.fn(),
          createRecord: vi.fn(),
          deleteRecord: vi.fn(),
          putRecord: vi.fn(),
        },
        server: {
          refreshSession: vi.fn(),
          getSession: vi.fn(),
          listAppPasswords: vi.fn(),
          createAppPassword: vi.fn(),
          revokeAppPassword: vi.fn(),
          getAccountInviteCodes: vi.fn(),
        },
        moderation: {
          createReport: vi.fn(),
        },
      },
    },
    app: {
      bsky: {
        feed: {
          searchPosts: vi.fn(),
        },
        graph: {
          getBlocks: vi.fn(),
        },
        bookmark: {
          createBookmark: vi.fn(),
          deleteBookmark: vi.fn(),
          getBookmarks: vi.fn(),
        },
        notification: {
          updateSeen: vi.fn(),
        },
      },
    },
    chat: {
      bsky: {
        convo: {
          listConvos: vi.fn(),
          getConvo: vi.fn(),
          getConvoForMembers: vi.fn(),
          getMessages: vi.fn(),
          sendMessage: vi.fn(),
          deleteMessageForSelf: vi.fn(),
          acceptConvo: vi.fn(),
          updateRead: vi.fn(),
          muteConvo: vi.fn(),
          unmuteConvo: vi.fn(),
        },
      },
    },
  };
  return agent;
}

export type MockAgent = ReturnType<typeof createMockAgent>;
