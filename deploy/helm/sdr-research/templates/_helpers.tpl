{{/* Common labels */}}
{{- define "sdr-research.labels" -}}
app.kubernetes.io/name: sdr-research
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Database URL — internal postgres or external override */}}
{{- define "sdr-research.databaseUrl" -}}
{{- if .Values.postgres.enabled -}}
postgresql://sdr_viewer:$(POSTGRES_PASSWORD)@{{ .Release.Name }}-postgres:5432/sdr_viewer
{{- else -}}
{{ .Values.externalDatabase.url }}
{{- end -}}
{{- end -}}
