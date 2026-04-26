# Bootstrap: Terraform remote state bucket on OVH Object Store (S3-compatible).
#
# Apply order:
#   1. terraform apply          — creates bucket with LOCAL state
#   2. Uncomment the backend block in providers.tf
#   3. terraform init -migrate-state  — moves state into the new bucket

resource "ovh_cloud_project_container" "tfstate" {
  service_name = var.ovh_cloud_project_service
  region_name  = var.region
  name         = "cip-tfstate"
}
