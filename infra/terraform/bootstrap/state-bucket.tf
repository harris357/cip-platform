# TODO: Bootstrap Terraform remote state bucket on OVH Object Store
# This file is applied manually before any other Terraform operations.
# After creating the bucket, configure the backend in providers.tf:
#
# terraform {
#   backend "s3" {
#     bucket                      = "cip-tfstate"
#     key                         = "bootstrap/terraform.tfstate"
#     region                      = "BHS"
#     endpoint                    = "https://s3.bhs.io.cloud.ovh.net"
#     skip_credentials_validation = true
#     skip_metadata_api_check     = true
#     skip_region_validation      = true
#     force_path_style            = true
#   }
# }
