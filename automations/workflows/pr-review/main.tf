# Reviews the PR when someone comments !review.

terraform {
  required_providers {
    cursor = { source = "cursor/cursor" }
  }
}

variable "repo" {
  type        = string
  description = "owner/repo to watch."
}

variable "prompt" {
  type        = string
  description = "Instructions for the agent."
}

variable "environment_id" {
  type        = string
  default     = null
  description = "Environment to run in. Null = the repo's default environment."
}

variable "allowed_users" {
  type        = list(string)
  default     = null # not [], the provider (0.8) reads an empty list back as null and fails the apply
  description = "Git usernames allowed to trigger. Null = anyone."
}

resource "cursor_platform_workflow" "this" {
  name                  = "PR review (${var.repo})"
  description           = "Reviews the PR when someone comments !review."
  prompt                = var.prompt
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
