terraform {
  required_version = ">= 1.6.0"
  required_providers {
    ovh = {
      source  = "ovh/ovh"
      version = "~> 0.40"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.27"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
  # Uncomment after running `terraform apply` once to create the cip-tfstate bucket,
  # then run `terraform init -migrate-state` to move state into OVH Object Store.
  # Credentials: set AWS_ACCESS_KEY_ID=$OVH_S3_ACCESS_KEY, AWS_SECRET_ACCESS_KEY=$OVH_S3_SECRET_KEY
  #
  # backend "s3" {
  #   bucket                      = "cip-tfstate"
  #   key                         = "bootstrap/terraform.tfstate"
  #   region                      = "BHS"
  #   endpoint                    = var.ovh_s3_endpoint   # set via TF_VAR_ovh_s3_endpoint or -backend-config
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   force_path_style            = true
  # }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "ovh" {
  endpoint           = var.ovh_endpoint
  application_key    = var.ovh_application_key
  application_secret = var.ovh_application_secret
  consumer_key       = var.ovh_consumer_key
}
