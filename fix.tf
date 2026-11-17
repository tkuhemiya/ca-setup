module "fix" {
  source       = "./modules/automation"
  name         = "fix"
  description  = "Implements the requested change when someone comments !fix."
  repos        = ["Ambulink-Main", "typst-editor"]
  trigger      = { comment = "!fix" }
  instructions = ["instructions/fix.md"]
}
