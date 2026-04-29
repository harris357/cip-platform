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

variable "cloudflare_api_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare API token with Zone:DNS:Edit permissions. Set via TF_VAR_cloudflare_api_token=$CLOUDFLARE_API_TOKEN in .envrc"
}

variable "cloudflare_tunnel_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare Tunnel token (from Zero Trust → Networks → Tunnels). Tunnel ID is derived from this. Set via TF_VAR_cloudflare_tunnel_token=$CLOUDFLARE_TUNNEL_TOKEN in .envrc"
}

variable "cloudflare_zone" {
  type        = string
  default     = "cip.idlevice.ca"
  description = "Cloudflare zone name for DNS records"
}
