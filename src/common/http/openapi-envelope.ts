import type {
  MediaTypeObject,
  OpenAPIObject,
  OperationObject,
  PathItemObject,
  ReferenceObject,
  ResponseObject,
  SchemaObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { API_RESPONSE_SCHEMA_VERSION } from "./api-response";

const JSON_CONTENT_TYPE = "application/json";
const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

const RAW_RESPONSE_PATHS = [
  "/auth/google",
  "/auth/google/callback",
  "/export",
  "/health",
  "/ready",
  "/metrics",
  "/internal/metrics",
  "/payment/webhook",
];

type HttpMethod = (typeof HTTP_METHODS)[number];

function isReferenceObject(
  value: ResponseObject | ReferenceObject | undefined
): value is ReferenceObject {
  return Boolean(value && "$ref" in value);
}

function isSuccessStatus(statusCode: string): boolean {
  return /^2\d\d$/.test(statusCode);
}

function shouldSkipPath(path: string): boolean {
  return RAW_RESPONSE_PATHS.some(
    (rawPath) => path === rawPath || path.startsWith(`${rawPath}/`)
  );
}

function getOperation(
  pathItem: PathItemObject,
  method: HttpMethod
): OperationObject | undefined {
  return pathItem[method];
}

function buildEnvelopeSchema(
  dataSchema: SchemaObject | ReferenceObject
): SchemaObject {
  return {
    type: "object",
    required: [
      "success",
      "schemaVersion",
      "statusCode",
      "code",
      "message",
      "data",
      "timestamp",
    ],
    properties: {
      success: { type: "boolean", enum: [true] },
      schemaVersion: {
        type: "string",
        enum: [API_RESPONSE_SCHEMA_VERSION],
      },
      statusCode: { type: "number" },
      code: { type: "string" },
      message: { type: "string" },
      data: dataSchema,
      meta: {
        type: "object",
        additionalProperties: true,
      },
      timestamp: { type: "string", format: "date-time" },
      path: { type: "string" },
      correlationId: { type: "string" },
    },
  };
}

function defaultDataSchema(): SchemaObject {
  return { nullable: true };
}

function wrapMediaType(media: MediaTypeObject): MediaTypeObject {
  const schema = media.schema ?? defaultDataSchema();
  return {
    ...media,
    schema: buildEnvelopeSchema(schema),
  };
}

function wrapResponse(response: ResponseObject): ResponseObject {
  const currentJson = response.content?.[JSON_CONTENT_TYPE];
  if (!currentJson) {
    return {
      ...response,
      content: {
        ...(response.content ?? {}),
        [JSON_CONTENT_TYPE]: {
          schema: buildEnvelopeSchema(defaultDataSchema()),
        },
      },
    };
  }

  return {
    ...response,
    content: {
      ...response.content,
      [JSON_CONTENT_TYPE]: wrapMediaType(currentJson),
    },
  };
}

export function applyApiResponseEnvelopeToOpenApi(
  document: OpenAPIObject
): OpenAPIObject {
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (shouldSkipPath(path)) {
      continue;
    }

    for (const method of HTTP_METHODS) {
      const operation = getOperation(pathItem, method);
      if (!operation) {
        continue;
      }

      for (const [statusCode, response] of Object.entries(
        operation.responses
      )) {
        if (
          !response ||
          !isSuccessStatus(statusCode) ||
          isReferenceObject(response)
        ) {
          continue;
        }

        operation.responses[statusCode] = wrapResponse(response);
      }
    }
  }

  return document;
}
