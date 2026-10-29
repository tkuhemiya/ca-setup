# Automations for AmbuLink-CS-55/Ambulink-Main.

variable "environment_ids" {
  type = map(string)
}

locals {
  repo           = "AmbuLink-CS-55/Ambulink-Main"
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
