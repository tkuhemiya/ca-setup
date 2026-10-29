provider "cursor" {
  # Auth via CURSOR_TOKEN.
}

# One block per repo. Each repos/<owner>/<repo>/ folder lists the automations that repo runs
# and holds its prompts. Automation types live in workflows/, shared prompts in prompts/.

locals {
  # Written by environments/sync.mjs. Run it before the first apply.
  environment_ids = jsondecode(file("../environments/ids.json"))
}

module "ambulink_main" {
  source          = "./repos/AmbuLink-CS-55/Ambulink-Main"
  environment_ids = local.environment_ids
}

module "typst_editor" {
  source          = "./repos/tkuhemiya/typst-editor"
  environment_ids = local.environment_ids
}
