# Implements the requested change when someone comments !fix.

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
  name                  = "PR fix (${var.repo})"
  description           = "Implements the requested change when someone comments !fix."
  prompt                = var.prompt
  environment_public_id = var.environment_id

  # Grok 4.6 defaults to effort = high and fast = true, so both must be explicit.
  # max_mode is always reported back as true; leaving it unset fails the apply.
  model_selection = {
    model_id = "grok-4.6"
    max_mode = true
    parameters = [
      { id = "effort", value = "medium" },
      { id = "fast", value = "false" },
    ]
  }

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
