# One automation, written once and run on a list of repos. Each repo gets its own Cursor workflow, because a
# workflow has a single environment and each repo has its own.

terraform {
  required_providers {
    cursor = { source = "cursor/cursor" }
  }
}

variable "name" {
  type        = string
  description = "Short name, such as review. It labels the workflow and the run's trace."
}

variable "description" {
  type        = string
  description = "Shown in the Cursor dashboard."
}

variable "repos" {
  type        = list(string)
  description = "Folder names under repos/. Each needs an environment.json and a synced environment."
}

variable "trigger" {
  type = object({
    comment       = optional(string)      # a pull request comment containing this text
    label         = optional(string)      # this label added to a pull request (GitHub only)
    cron          = optional(string)      # a schedule, such as "0 9 * * *"
    webhook       = optional(bool, false) # a POST to the workflow's webhook URL
    allowed_users = optional(list(string))
  })
  description = "What starts a run. Set one of comment, label, cron or webhook. allowed_users limits who can start it; leave it out for anyone."

  validation {
    condition     = length([for set in [var.trigger.comment != null, var.trigger.label != null, var.trigger.cron != null, var.trigger.webhook] : set if set]) == 1
    error_message = "Set exactly one of comment, label, cron or webhook."
  }

  validation {
    # Provider 0.8 reads an empty list back as null and then fails the apply.
    condition     = var.trigger.allowed_users == null || length(coalesce(var.trigger.allowed_users, [])) > 0
    error_message = "Leave allowed_users out to allow anyone. An empty list fails the apply."
  }
}

variable "model" {
  type = object({
    id     = string
    params = map(string)
  })
  # Most models default to their fast, high-effort variant, so every parameter is set.
  # Parameter names differ between models. GET https://api.cursor.com/v1/models lists them.
  default = {
    id     = "grok-4.6"
    params = { effort = "medium", fast = "false" }
  }
  description = "Canonical model id and its parameters."
}

variable "tools" {
  type = object({
    mcp             = optional(list(string), []) # names of MCP servers already registered in Cursor
    pr_comment      = optional(bool, true)       # comment on the pull request
    inline_comments = optional(bool)             # comment on specific diff lines
    approve         = optional(bool)             # approve the pull request
    memory          = optional(bool)             # keep notes between runs
  })
  default     = {}
  description = "What the agent may use besides the repo."
}

variable "instructions" {
  type        = list(string)
  description = "Markdown files, joined in order into the prompt. Paths start at the repo root. {repo} becomes the repo's folder name."
}

locals {
  # Written by scripts/sync-environments.mjs: folder name -> { id, host, repo }.
  environments = jsondecode(file("${path.root}/ids.json"))
}

resource "cursor_platform_workflow" "this" {
  for_each = toset(var.repos)

  name        = "${var.name} (${local.environments[each.key].repo})"
  description = var.description

  # The last line labels the run's trace. observability/export.mjs reads it.
  prompt = join("\n\n", concat(
    [for instruction in var.instructions : trimspace(file("${path.root}/${replace(instruction, "{repo}", each.key)}"))],
    ["<!-- automation: ${var.name} -->"],
  ))

  # A repo missing from ids.json stops the plan here. Without an id Cursor would pick an environment itself.
  environment_public_id = local.environments[each.key].id

  # max_mode is always reported back as true; leaving it unset fails the apply.
  model_selection = {
    model_id   = var.model.id
    max_mode   = true
    parameters = [for id, value in var.model.params : { id = id, value = value }]
  }

  # A comment or label names its repo in the trigger. A schedule or webhook has no repo of its own.
  git_repo = var.trigger.cron != null || var.trigger.webhook ? "${local.environments[each.key].host}/${local.environments[each.key].repo}" : null

  trigger = [{
    git_pull_request = var.trigger.comment == null ? null : {
      # A bare owner/repo means GitHub. Any other host is written out.
      repos            = [local.environments[each.key].host == "github.com" ? local.environments[each.key].repo : "${local.environments[each.key].host}/${local.environments[each.key].repo}"]
      pr_action        = "commented"
      comment_contains = var.trigger.comment
    }
    git_label = var.trigger.label == null ? null : {
      repos         = [local.environments[each.key].repo]
      label_name    = var.trigger.label
      pull_requests = true
      on_added      = true
    }
    cron           = var.trigger.cron == null ? null : { schedule = var.trigger.cron }
    webhook        = var.trigger.webhook ? {} : null
    user_allowlist = var.trigger.allowed_users
  }]

  memory_enabled = var.tools.memory

  action = concat(
    var.tools.pr_comment ? [{ pr_comment = { allow_inline_comments = var.tools.inline_comments, allow_approve = var.tools.approve } }] : [],
    [for server in var.tools.mcp : { mcp = { server = server } }],
  )
}
