# The four workflows that existed before the layout changed on 2026-11-16. These keep their ids, so Terraform
# updates them in place. Delete this file once every state has been applied past the change.

moved {
  from = module.ambulink_main.module.review.cursor_platform_workflow.this
  to   = module.review.cursor_platform_workflow.this["Ambulink-Main"]
}

moved {
  from = module.ambulink_main.module.fix.cursor_platform_workflow.this
  to   = module.fix.cursor_platform_workflow.this["Ambulink-Main"]
}

moved {
  from = module.typst_editor.module.review.cursor_platform_workflow.this
  to   = module.review.cursor_platform_workflow.this["typst-editor"]
}

moved {
  from = module.typst_editor.module.fix.cursor_platform_workflow.this
  to   = module.fix.cursor_platform_workflow.this["typst-editor"]
}
