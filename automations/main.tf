provider "cursor" {
  # Auth via CURSOR_TOKEN.
}

# Each repo gets its own <repo>.tf listing the automations it runs.
# Automation types live in workflows/, prompts in prompts/.

locals {
  # Written by environments/sync.mjs. Run it before the first apply.
  environment_ids = jsondecode(file("../environments/ids.json"))
}
