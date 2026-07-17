import { Notification } from "@src/schemas/notification.schema";
import { Types } from "mongoose";

export type NotificationDocument = Notification & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
