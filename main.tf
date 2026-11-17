provider "cursor" {
  # Auth via CURSOR_TOKEN.
}

# One file per automation: review.tf, fix.tf. Each lists the repos it runs on.
# modules/automation turns one into a Cursor workflow per repo.
