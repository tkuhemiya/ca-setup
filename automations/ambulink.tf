# AmbuLink-CS-55/Ambulink-Main

module "ambulink_review" {
  source         = "./workflows/pr-review"
  repo           = "AmbuLink-CS-55/Ambulink-Main"
  environment_id = local.environment_ids["AmbuLink-CS-55/Ambulink-Main"]
  prompt         = file("prompts/AmbuLink-CS-55/Ambulink-Main/review.md")
}

module "ambulink_fix" {
  source         = "./workflows/pr-fix"
  repo           = "AmbuLink-CS-55/Ambulink-Main"
  environment_id = local.environment_ids["AmbuLink-CS-55/Ambulink-Main"]
  prompt         = file("prompts/fix.md")
}
