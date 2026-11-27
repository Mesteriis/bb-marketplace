/** The line review's agent tools; each name starts with the plugin's own prefix, unique across BB plugins. */
export const TOOL = {
  threads: "git_review_threads",
  comment: "git_review_comment",
  generalComment: "git_review_general_comment",
  reply: "git_review_reply",
  resolve: "git_review_resolve",
  dismiss: "git_review_dismiss",
} as const;
export const TOOL_NAMES: string[] = Object.values(TOOL);
/** The key under which a run's thread carries its run id, in this plugin's thread metadata. */
export const RUN_METADATA_KEY = "makoshReviewRunId";
