# Automations for tkuhemiya/typst-editor.

variable "environment_ids" {
  type = map(string)
}

locals {
  repo           = "tkuhemiya/typst-editor"
  environment_id = var.environment_ids[local.repo]
}

module "review" {
  source         = "../../../workflows/pr-review"
  repo           = local.repo
  environment_id = local.environment_id
  prompt         = file("${path.module}/review.md")
}

module "fix" {
  source         = "../../../workflows/pr-fix"
  repo           = local.repo
  environment_id = local.environment_id
  prompt         = file("${path.root}/prompts/fix.md")
}
