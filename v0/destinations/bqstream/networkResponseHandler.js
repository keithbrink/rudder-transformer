/* eslint-disable no-param-reassign */
const getValue = require("get-value");
const { getDynamicMeta } = require("../../../adapters/utils/networkUtils");
const {
  DestinationResponseBuilder: DestinationRespBuilder
} = require("../../util/response-builders");
const {
  DISABLE_DEST,
  REFRESH_TOKEN
} = require("../../../adapters/networkhandler/authConstants");
const { TRANSFORMER_METRIC } = require("../../util/constant");

const DESTINATION_NAME = "bqstream";

const trimBqStreamResponse = response => ({
  code: getValue(response, "response.response.data.error.code"), // data.error.status which contains PERMISSION_DENIED
  status: getValue(response, "response.response.status"),
  statusText: getValue(response, "response.response.statusText"),
  headers: getValue(response, "response.response.headers"),
  data: getValue(response, "response.response.data"), // Incase of errors, this contains error data
  success: getValue(response, "suceess")
});
/**
 * Obtains the Destination OAuth Error Category based on the error code obtained from destination
 *
 * - If an error code is such that the user will not be allowed inside the destination,
 * such error codes fall under DISABLE_DESTINATION
 * - If an error code is such that upon refresh we can get a new token which can be used to send event,
 * such error codes fall under REFRESH_TOKEN category
 * - If an error code doesn't fall under both categories, we can return an empty string
 * @param {string} errorCategory - The error code obtained from the destination
 * @returns Destination OAuth Error Category
 */
const getDestAuthCategory = errorCategory => {
  switch (errorCategory) {
    case "PERMISSION_DENIED":
      return DISABLE_DEST;
    case "UNAUTHENTICATED":
      return REFRESH_TOKEN;
    default:
      return "";
  }
};

/**
 * Gets accessToken information from the destination request
 * This is used to send the information to the token endpoint for refreshing purposes
 *
 * @param {Object} payload - Request to the destination will contain accessToken for OAuth supported destinations
 * @returns Access token from the request
 */
const getAccessTokenFromDestRequest = payload =>
  payload.headers.Authorization.split(" ")[1];

/**
 * This class actually handles the response for BigQuery Stream API
 * It can also be used for any Google related API but an API related handling has to be done separately
 *
 * Here we are only trying to handle OAuth related error(s)
 * Any destination specific error handling has to be done in their own way
 *
 * Reference doc for OAuth Errors
 * 1. https://cloud.google.com/apigee/docs/api-platform/reference/policies/oauth-http-status-code-reference
 * 2. https://cloud.google.com/bigquery/docs/error-messages
 */
const responseHandler = ({ dresponse, accessToken } = {}) => {
  const isSuccess =
    !dresponse.error &&
    (!dresponse.insertErrors ||
      (dresponse.insertErrors && dresponse.insertErrors.length === 0));
  if (isSuccess) {
    return new DestinationRespBuilder()
      .setStatus(200)
      .setMessage("Request Processed successfully")
      .setAuthErrorCategory("")
      .isTransformResponseFailure(!isSuccess)
      .setStatTags({
        destination: DESTINATION_NAME,
        scope: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.SCOPE,
        stage: TRANSFORMER_METRIC.TRANSFORMER_STAGE.RESPONSE_TRANSFORM,
        meta: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.META.SUCCESS
      })
      .build();
  }
  if (dresponse.error) {
    const destAuthCategory = getDestAuthCategory(dresponse.error.status);
    // There is a case of 404, which will make the server panic, hence handling
    // that case as aborted
    const status = destAuthCategory ? 500 : 400;
    throw new DestinationRespBuilder()
      .setStatus(status)
      .setMessage(dresponse.error.message || "BQStream request failed")
      .setAuthErrorCategory(destAuthCategory)
      .setAccessToken(accessToken)
      .isTransformResponseFailure(!isSuccess)
      .setStatTags({
        destination: DESTINATION_NAME,
        scope: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.SCOPE,
        stage: TRANSFORMER_METRIC.TRANSFORMER_STAGE.RESPONSE_TRANSFORM,
        meta: getDynamicMeta(status)
      })
      .build();
  } else if (dresponse.insertErrors && dresponse.insertErrors.length > 0) {
    const temp = trimBqStreamResponse(dresponse);
    throw new DestinationRespBuilder()
      .setStatus(400)
      .setMessage("Problem during insert operation")
      .setAuthErrorCategory("")
      .setAccessToken(accessToken)
      .isTransformResponseFailure(!isSuccess)
      .setStatTags({
        destination: DESTINATION_NAME,
        scope: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.SCOPE,
        stage: TRANSFORMER_METRIC.TRANSFORMER_STAGE.RESPONSE_TRANSFORM,
        meta: getDynamicMeta(temp.status || 400)
      })
      .build();
  }
  throw new DestinationRespBuilder()
    .setStatus(400)
    .setMessage("Unhandled error type while sending to destination")
    .setAuthErrorCategory("")
    .setAccessToken(accessToken)
    .isTransformResponseFailure(!isSuccess)
    .setStatTags({
      destination: DESTINATION_NAME,
      scope: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.SCOPE,
      stage: TRANSFORMER_METRIC.TRANSFORMER_STAGE.RESPONSE_TRANSFORM,
      meta: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.META.ABORTABLE
    })
    .build();
};

const responseTransform = respTransformPayload => {
  const { payload, responseBody, status } = respTransformPayload;
  const accessToken = getAccessTokenFromDestRequest(payload);
  // if (!status) {
  //   throw new DestinationRespBuilder()
  //     .setStatus(500)
  //     .setAuthErrorCategory("")
  //     .setMessage("Uncaught error here")
  //     .setStatTags({
  //       destination: DESTINATION_NAME,
  //       scope: TRANSFORMER_METRIC.MEASUREMENT_TYPE.API.SCOPE,
  //       stage: TRANSFORMER_METRIC.TRANSFORMER_STAGE.RESPONSE_TRANSFORM,
  //       meta: getDynamicMeta(500)
  //     })
  //     .setDestinationResponse(respTransformPayload)
  //     .isTransformResponseFailure(true)
  //     .build();
  // }
  const parsedResponse = responseHandler({
    dresponse: responseBody,
    accessToken
  });
  return {
    status: parsedResponse.status,
    destinationResponse: responseBody,
    message: parsedResponse.message || "Request Processed Successfully",
    statTags: parsedResponse.statTags
  };
};

module.exports = { responseTransform };
