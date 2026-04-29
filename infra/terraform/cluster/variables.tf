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
  type = string
}

variable "cluster_id" {
  type        = string
  description = "OVH cluster ID (from bootstrap outputs)"
}

variable "nodepool_flavor" {
  type    = string
  default = "b3-8"
}

variable "nodepool_min_size" {
  type    = number
  default = 1
}

variable "nodepool_max_size" {
  type    = number
  default = 1
}

variable "domain" {
  type        = string
  description = "Apex domain (e.g. idlevice.ca). Set via TF_VAR_domain=$DOMAIN in .envrc"
  default     = "idlevice.ca"
}

variable "env_prefix" {
  type        = string
  description = "Environment identifier appended to service subdomains (e.g. 'cip' → keycloak-cip.idlevice.ca). Set via TF_VAR_env_prefix=$ENV_PREFIX in .envrc"
  default     = "cip"
}
