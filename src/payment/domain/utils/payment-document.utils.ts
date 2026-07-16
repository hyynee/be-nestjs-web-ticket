import { BadRequestException } from "@nestjs/common";
import { Types } from "mongoose";

export const toPaymentObjectId = (
  value: Types.ObjectId | string | object | null | undefined,
  fieldName: string
): Types.ObjectId => {
  if (value instanceof Types.ObjectId) {
    return value;
  }

  if (typeof value === "string") {
    return new Types.ObjectId(value);
  }

  if (value && "_id" in value) {
    const nestedId = value._id;
    if (nestedId instanceof Types.ObjectId) {
      return nestedId;
    }
    if (typeof nestedId === "string") {
      return new Types.ObjectId(nestedId);
    }
  }

  throw new BadRequestException(`${fieldName} is missing`);
};
