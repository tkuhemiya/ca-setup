# Implements a requested change on the PR when someone comments !fix.

resource "cursor_platform_workflow" "this" {
  name                  = "PR fix (${var.repo})"
  description           = "Implements the requested change when someone comments !fix."
  prompt                = file("${path.module}/fix.md")
  environment_public_id = var.environment_id

  trigger = [{
    git_pull_request = {
      repos            = [var.repo]
      pr_action        = "commented"
      comment_contains = "!fix"
    }
    user_allowlist = var.allowed_users
  }]

  action = [{ pr_comment = {} }]
}
