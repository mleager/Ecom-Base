// Package deploycheck holds helpers for scripts/deploy-verify.sh. Its tests
// carry the deploycheck build tag, so check and the integration suite never
// run them; they act only on the verification deployment's database.
package deploycheck
