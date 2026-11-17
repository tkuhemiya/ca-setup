module "review" {
  source       = "./modules/automation"
  name         = "review"
  description  = "Reviews the PR when someone comments !review."
  repos        = ["Ambulink-Main", "typst-editor"]
  trigger      = { comment = "!review" }
  tools        = { mcp = ["executor"], inline_comments = false }
  instructions = ["repos/{repo}/review.md"]
}
