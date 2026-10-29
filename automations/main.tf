provider "cursor" {
  # Auth via CURSOR_TOKEN.
}

# One block per automation per repo.
# pr-review reads its prompt from prompts/<owner>/<repo>/review.md; pr-fix uses one shared prompt (modules/pr-fix/fix.md).
# After running environments/sync.mjs, add the id it prints to each block: environment_id = "..."

module "ambulink_review" {
  source = "./modules/pr-review"
  repo   = "AmbuLink-CS-55/Ambulink-Main"
}

module "ambulink_fix" {
  source = "./modules/pr-fix"
  repo   = "AmbuLink-CS-55/Ambulink-Main"
}

module "typst_review" {
  source = "./modules/pr-review"
  repo   = "tkuhemiya/typst-editor"
}

module "typst_fix" {
  source = "./modules/pr-fix"
  repo   = "tkuhemiya/typst-editor"
}
