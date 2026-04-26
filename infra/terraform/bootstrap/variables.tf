variable "ovh_endpoint" {
  type    = string
  default = "ovh-ca"
}

variable "ovh_application_key" {
  type      = string
  sensitive = true
}

variable "ovh_application_secret" {
  type      = string
  sensitive = true
}

variable "ovh_consumer_key" {
  type      = string
  sensitive = true
}

variable "ovh_cloud_project_service" {
  type        = string
  description = "OVH Cloud project (service name)"
}

variable "region" {
  type    = string
  default = "BHS5"
}

variable "cluster_name" {
  type    = string
  default = "cip-dev"
}

variable "private_network_id" {
  type        = string
  description = "OpenStack UUID of the private network for cluster nodes (OVH Console → Network → Private Networks → Network ID column)"
  # Set via: export TF_VAR_private_network_id=<uuid>  or add to .envrc as OVH_PRIVATE_NETWORK_ID
}
