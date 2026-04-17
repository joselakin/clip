import type { JobStatus, JobType } from "@prisma/client";

type RunningJob = {
  id: string;
  videoId: string;
  jobType: JobType;
  status: JobStatus;
  createdAt: Date;
};

type JobFindFirstArgs = {
  where: {
    videoId: string;
    jobType: JobType;
    status: JobStatus;
  };
  orderBy: {
    createdAt: "desc";
  };
};

type PrismaLike = {
  job: {
    findFirst(args: JobFindFirstArgs): Promise<RunningJob | null>;
  };
};

type FindRunningJobInput = {
  videoId: string;
  jobType: JobType;
};

export async function findRunningJobForStep(
  prismaLike: PrismaLike,
  input: FindRunningJobInput
): Promise<RunningJob | null> {
  return prismaLike.job.findFirst({
    where: {
      videoId: input.videoId,
      jobType: input.jobType,
      status: "running",
    },
    orderBy: {
      createdAt: "desc",
    },
  });
}
