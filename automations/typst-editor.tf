# tkuhemiya/typst-editor

module "typst_editor_review" {
  source         = "./workflows/pr-review"
  repo           = "tkuhemiya/typst-editor"
  environment_id = local.environment_ids["tkuhemiya/typst-editor"]
  prompt         = file("prompts/tkuhemiya/typst-editor/review.md")
}

module "typst_editor_fix" {
  source         = "./workflows/pr-fix"
  repo           = "tkuhemiya/typst-editor"
  environment_id = local.environment_ids["tkuhemiya/typst-editor"]
  prompt         = file("prompts/fix.md")
}
