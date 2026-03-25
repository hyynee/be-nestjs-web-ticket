import { BadRequestException } from "@nestjs/common";

export class Permission {
  static check(currentUser: { role: string }) {
    const { role } = currentUser;
    // if (id === userId) return;
    if (role === "admin") return;
    throw new BadRequestException("USER can not perform action");
  }
}
