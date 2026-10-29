variable "repo" {
  type        = string
  description = "owner/repo to watch. The prompt is read from prompts/<owner>/<repo>/."
}

variable "environment_id" {
  type        = string
  default     = null
  description = "Environment to run in (printed by environments/sync.mjs). Unset = the repo's default environment."
}

variable "allowed_users" {
  type        = list(string)
  default     = []
  description = "Git usernames allowed to trigger. Empty = anyone."
}
