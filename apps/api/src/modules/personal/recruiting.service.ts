import { singleton } from "tsyringe";
import { readRecruitingDashboard } from "./recruiting-loader";
import { personalConfiguration, personalRoot } from "./runtime";

@singleton()
export class PersonalRecruitingService {
  async dashboard(userId: string) {
    await personalConfiguration(userId);
    return readRecruitingDashboard(personalRoot());
  }
}
