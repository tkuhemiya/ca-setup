# Reviews a pull request when someone comments !review.

resource "cursor_platform_workflow" "this" {
  name                  = "PR review (${var.repo})"
  description           = "Reviews the PR when someone comments !review."
  prompt                = file("${path.root}/prompts/${var.repo}/review.md")
  environment_public_id = var.environment_id

  trigger = [{
    git_pull_request = {
      repos            = [var.repo]
      pr_action        = "commented"
      comment_contains = "!review"
    }
    user_allowlist = var.allowed_users
  }]

  action = [{ pr_comment = { allow_inline_comments = false } }]
}
